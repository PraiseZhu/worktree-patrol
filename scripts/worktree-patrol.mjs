#!/usr/bin/env node
// worktree-patrol — 目标仓 git worktree 每日巡检的调度侧 wrapper。
// 与 cindy_scheduler 的分工:
//   hook 子命令   = preRunHook:纯只读判定「本轮要不要跑」。exit 0=有事(起 agent)、
//                   exit 2=无变化(skip,零 token)、exit 1=采集失败(run failed 可见)。
//                   hook **永不写任何文件**——scheduler 的 self-test 因此天然零写。
//   report 子命令 = agent 轮执行:重新采集、打印人读摘要(聚合计数,不倾倒全部绝对路径)、
//                   原子写 pending 记录;agent 拿摘要调 schedule_notify_current_run,
//                   通知成功后才允许 ack。
//   ack 子命令    = 把 pending 晋升为 last-good 基线。通知没送成就不 ack,
//                   下一轮 hook 会继续 exit 0 重报(pending 未确认不静默)。
//
// 巡检器与本 wrapper 同仓(scripts/repo-worktrees.mjs),不再有跨仓 fallback 链——
// 工具是本机个人卫生工具,不寄居在被巡检的项目仓里。被巡检目标仓由 TARGET_REPO
// 指定(默认 mivo),可用 WORKTREE_PATROL_TARGET_REPO 覆盖。
// 状态唯一落点: <本仓>/state/state.json(tmp+rename 原子写,同目录 lock;已 gitignore)。
// 对 git 零写:采集走 repo-worktrees.mjs(只读契约,GIT_OPTIONAL_LOCKS=0),本脚本只写 state 目录。

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 本仓根(scripts/ 的上一级);巡检器固定取本仓 scripts/repo-worktrees.mjs
const TOOL_ROOT = join(import.meta.dirname, '..');
// 被巡检的目标仓(worktree registry 属于它)
const MAIN_REPO = process.env.WORKTREE_PATROL_TARGET_REPO || '/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas';
const STATE_DIR = process.env.WORKTREE_PATROL_STATE_DIR || join(TOOL_ROOT, 'state');
const STATE_PATH = join(STATE_DIR, 'state.json');
const LOCK_PATH = join(STATE_DIR, 'state.lock');
const SCHEMA_VERSION = 1;

// 风险语义(与 repo-worktrees-core 的分类字符串绑定)
const DANGER = new Set(['detached dirty danger', 'missing (unknown state)', 'unknown (probe failed)', 'HEAD merged, worktree dirty', 'dirty WIP']);
const PROTECTED = new Set(['active PR', 'dirty WIP', 'local unpushed feature', 'main clean']);

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// 巡检器只有一个来源(同仓 scripts/);缺文件或接口不过 → 返回 null,调用方 fail-visible。
// 不做多来源猜测:猜错来源等于用未知版本的判定逻辑出报告。
function resolveInspector() {
  const cli = join(TOOL_ROOT, 'scripts/repo-worktrees.mjs');
  const core = join(TOOL_ROOT, 'scripts/repo-worktrees-core.mjs');
  if (!existsSync(cli) || !existsSync(core)) {
    process.stderr.write(`[patrol] 巡检器缺失: ${cli}\n`);
    return null;
  }
  try {
    const out = execFileSync(process.execPath, [cli, '--json'], {
      cwd: MAIN_REPO, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(out);
    if (!Array.isArray(report.rows)) throw new Error('rows 不是数组');
    return {
      report,
      source: { tag: 'worktree-patrol', cli, cliSha256: sha256(readFileSync(cli, 'utf8')), coreSha256: sha256(readFileSync(core, 'utf8')) },
    };
  } catch (error) {
    process.stderr.write(`[patrol] 巡检器执行失败: ${String(error.message).slice(0, 200)}\n`);
    return null;
  }
}

// 采集并做完整性裁决:任何不完整都算失败(fail-visible),不许在残缺数据上做静默判定。
function collect() {
  const resolved = resolveInspector();
  if (!resolved) throw new Error('巡检器不可用(见上方 stderr)');
  const { report, source } = resolved;
  if (report.prLookup?.status !== 'ok') throw new Error(`prLookup=${report.prLookup?.status}(${report.prLookup?.reason})——PR 完整性缺失,本轮记 failed 不推进基线`);
  if (!report.commonDir?.startsWith(MAIN_REPO)) throw new Error(`commonDir 不符: ${report.commonDir}`);
  const perPath = {};
  for (const row of report.rows) {
    if (!row.path || !row.classification) throw new Error('存在缺 path/classification 的行');
    if (perPath[row.path]) throw new Error(`重复 path: ${row.path}`);
    if (!row.prunable && !row.missing && !row.complete) throw new Error(`row 不完整: ${row.path}`);
    perPath[row.path] = {
      classification: row.classification,
      dirty: row.dirty, untracked: row.untracked,
      removable: row.removable, prunable: row.prunable,
      branch: row.branch,
    };
  }
  const canonical = JSON.stringify(perPath);
  return { perPath, reportHash: sha256(canonical), generatedAt: report.generatedAt, host: hostname(), source };
}

// 与基线比较,产出「新坏状态」增量(同一已确认状态不重复报——安静规则)。
function diffAgainst(baseline, current) {
  const alerts = [];
  const base = baseline?.perPath ?? null;
  if (!base) {
    const counts = countBy(current.perPath);
    alerts.push(`首次基线: ${Object.keys(current.perPath).length} 个注册项(${counts})`);
    return alerts;
  }
  for (const [path, now] of Object.entries(current.perPath)) {
    const prev = base[path];
    const short = path.split('/').slice(-1)[0];
    if (!prev) {
      if (DANGER.has(now.classification)) alerts.push(`新增高危: ${short} → ${now.classification}`);
      else if (now.removable) alerts.push(`新增可删项: ${short}`);
      else if (now.prunable) alerts.push(`新增 prunable: ${short}`);
      continue;
    }
    if (!DANGER.has(prev.classification) && DANGER.has(now.classification)) {
      alerts.push(`风险升级: ${short} ${prev.classification} → ${now.classification}`);
    } else if (DANGER.has(now.classification) && (now.dirty > prev.dirty || now.untracked > prev.untracked)) {
      alerts.push(`脏度上升: ${short} dirty ${prev.dirty}→${now.dirty}`);
    }
    if (!prev.removable && now.removable) alerts.push(`转入可删: ${short}`);
    if (!prev.prunable && now.prunable) alerts.push(`转入 prunable: ${short}`);
  }
  for (const [path, prev] of Object.entries(base)) {
    if (!current.perPath[path] && PROTECTED.has(prev.classification)) {
      alerts.push(`受保护项消失: ${path.split('/').slice(-1)[0]}(原 ${prev.classification})——非本巡检授权的删除,请核`);
    }
  }
  return alerts;
}

function countBy(perPath) {
  const counts = {};
  for (const row of Object.values(perPath)) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ');
}

function readState() {
  if (!existsSync(STATE_PATH)) return { schemaVersion: SCHEMA_VERSION, lastGood: null, pending: null };
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  if (state.schemaVersion !== SCHEMA_VERSION) throw new Error(`state schemaVersion 不符: ${state.schemaVersion}`);
  return state;
}

function writeStateAtomic(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const age = Date.now() - Number(readFileSync(LOCK_PATH, 'utf8') || 0);
    if (age < 10 * 60 * 1000) throw new Error('state.lock 被占用(并发实例?),本轮放弃写入');
  }
  writeFileSync(LOCK_PATH, String(Date.now()));
  try {
    const tmp = `${STATE_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, STATE_PATH);
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'hook') {
    // 纯只读:任何路径都不写文件。
    let state;
    try { state = readState(); } catch (error) { console.error(`[patrol] state 损坏: ${error.message}`); process.exit(1); }
    let current;
    try { current = collect(); } catch (error) { console.error(`[patrol] 采集失败: ${error.message}`); process.exit(1); }
    if (state.pending) { console.error('[patrol] 存在未确认 pending,继续报'); process.exit(0); }
    const alerts = diffAgainst(state.lastGood, current);
    if (alerts.length > 0) { console.error(`[patrol] ${alerts.length} 条新情况`); process.exit(0); }
    console.error('[patrol] 与已确认基线一致,本轮跳过');
    process.exit(2);
  } else if (cmd === 'report') {
    const state = readState();
    const current = collect();
    const alerts = state.pending ? [...state.pending.alerts] : diffAgainst(state.lastGood, current);
    const pending = {
      id: `p-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      reportHash: current.reportHash,
      alerts,
      snapshot: { perPath: current.perPath, generatedAt: current.generatedAt, source: current.source, host: current.host },
    };
    writeStateAtomic({ ...state, pending });
    console.log(`PENDING_ID=${pending.id}`);
    console.log(`[mivo worktree 巡检 @${current.host}] 来源=${current.source.tag} 注册项=${Object.keys(current.perPath).length}`);
    for (const alert of alerts.slice(0, 8)) console.log(`- ${alert}`);
    if (alerts.length > 8) console.log(`- …另 ${alerts.length - 8} 条,详见 state.json`);
  } else if (cmd === 'ack') {
    const idFlag = process.argv[process.argv.indexOf('--pending') + 1];
    const state = readState();
    if (!state.pending) { console.error('无 pending 可确认'); process.exit(1); }
    if (state.pending.id !== idFlag) { console.error(`pending id 不符: 现存 ${state.pending.id}`); process.exit(1); }
    writeStateAtomic({
      schemaVersion: SCHEMA_VERSION,
      lastGood: { perPath: state.pending.snapshot.perPath, reportHash: state.pending.reportHash, generatedAt: state.pending.snapshot.generatedAt, source: state.pending.snapshot.source, ackedAt: new Date().toISOString() },
      pending: null,
    });
    console.log(`已确认基线 ${state.pending.reportHash.slice(0, 12)}`);
  } else {
    console.error('用法: worktree-patrol.mjs hook|report|ack --pending <id>');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
