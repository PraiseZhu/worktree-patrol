#!/usr/bin/env node
// worktree-patrol — 每日巡检+自动清理的调度侧编排(P1-D 共识版)。
// 链路: hook(只读判定) → report(bootstrap→preserve→reclaim→复采→写 pending+通知文本)
//       → [scheduler agent 发通知] → ack(校验绑定后晋升基线)。
//
// 与旧版(只报告)的关键差异:
//   - report 现在是完整清理链;pending.snapshot 是 **post-reclaim** 复采结果——
//     pre-reclaim 快照只是 intention,绝不晋升基线(D SC1)。
//   - 通知四分区互斥并集 == 冻结 cohort,计数由台账逐项重算,不信调用方传数(D SC2)。
//   - 任何 failed/stale/conflict → pending.ok=false → ack 拒绝 → 次轮 hook 必 exit 0
//     重试(即使 registry 字节不变,D SC3)。
//   - hook 触发面: pending 未确认 / 首轮 / source|config 指纹变化 / registry hash 变化 /
//     policy deadline(activityAt+T)到期。全程零写(D SC4/SC5)。

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, canonicalize } from './ledger-core.mjs';
import { git } from './repo-worktrees.mjs';
import {
  STATE_DIR, bootstrap, computeSourceHash, loadConfig, readLedger,
} from './ledger-bootstrap.mjs';
import { preserveAll } from './preserve.mjs';
import { reclaimAll } from './reclaim.mjs';

const TOOL_ROOT = join(import.meta.dirname, '..');
const MAIN_REPO = process.env.WORKTREE_PATROL_TARGET_REPO || '/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas';
const CONFIG_PATH = process.env.WORKTREE_PATROL_CONFIG || join(TOOL_ROOT, 'config', 'patrol.config.json');
const STATE_SCHEMA_VERSION = 2;

const statePath = () => join(STATE_DIR(), 'state.json');
const nowMs = () => Number(process.env.PATROL_NOW_MS || Date.now());

function readState() {
  if (!existsSync(statePath())) return { schemaVersion: STATE_SCHEMA_VERSION, lastGood: null, pending: null };
  const state = JSON.parse(readFileSync(statePath(), 'utf8'));
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    // v1(只报告时代)基线与 v2 语义不兼容:按无基线处理,首轮全量重建(不静默丢 pending 之外的信息)
    return { schemaVersion: STATE_SCHEMA_VERSION, lastGood: null, pending: null, migratedFrom: state.schemaVersion };
  }
  return state;
}

function writeStateAtomic(state) {
  mkdirSync(STATE_DIR(), { recursive: true });
  const tmp = `${statePath()}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(canonicalize(state), null, 2)}\n`);
  renameSync(tmp, statePath());
}

function porcelainHashOf(repo) {
  return sha256(git(['worktree', 'list', '--porcelain'], { cwd: repo }));
}

function ledgerHashOf() {
  const path = join(STATE_DIR(), 'ledger.json');
  return existsSync(path) ? sha256(readFileSync(path, 'utf8')) : 'absent';
}

// 台账 → 四分区(互斥;并集必须 == 本轮 cohort,D SC2)
const PARTITION_OF = (entry) => {
  if (entry.disposition === 'keep') return 'keep';
  if (entry.disposition === 'unledgerable') return 'unledgerable';
  // disposition === 'reclaim'
  if (entry.lifecycle === 'reclaimed') return 'reclaimed';
  return 'failed'; // preserve-failed / reclaim-failed / stale / conflict / 半途 lifecycle
};

function partition(cohortEntryIds, ledger) {
  const parts = { reclaimed: [], keep: [], unledgerable: [], failed: [] };
  const missing = [];
  for (const entryId of cohortEntryIds) {
    const entry = ledger.entries[entryId];
    if (!entry) { missing.push(entryId); continue; }
    parts[PARTITION_OF(entry)].push({
      entryId,
      path: entry.evidence.literalPath,
      lifecycle: entry.lifecycle,
      reasons: entry.reasons,
      lastError: entry.lastError ?? null,
      receiptPath: entry.receiptPath ?? null,
      deadlineMs: entry.deadlineMs ?? null,
      runId: entry.runId,
    });
  }
  return { parts, missing };
}

function renderNotify({ runId, host, parts, cohortSize, deferredNextRun, alerts, ok }) {
  const lines = [];
  lines.push(`[worktree 巡检+清理 @${host}] run=${runId} cohort=${cohortSize} ${ok ? '' : '⚠️ 本轮有失败项'}`.trim());
  lines.push(`已清 ${parts.reclaimed.length} / 保留 ${parts.keep.length} / 建不了账 ${parts.unledgerable.length} / 失败·漂移·冲突 ${parts.failed.length}`);
  if (parts.reclaimed.length > 0) {
    lines.push(`— 已清(存证+恢复指引见 receipts):`);
    for (const item of parts.reclaimed.slice(0, 10)) lines.push(`  · ${short(item.path)}${item.receiptPath ? '' : '(crash-reconciled)'}`);
    if (parts.reclaimed.length > 10) lines.push(`  · …另 ${parts.reclaimed.length - 10} 项`);
    lines.push(`  恢复台账: ${join(STATE_DIR(), 'receipts')}/`);
  }
  if (parts.keep.length > 0) {
    lines.push(`— 保留(逐条理由):`);
    for (const item of parts.keep.slice(0, 12)) lines.push(`  · ${short(item.path)}: ${item.reasons[0]}`);
    if (parts.keep.length > 12) lines.push(`  · …另 ${parts.keep.length - 12} 项`);
  }
  if (parts.unledgerable.length > 0) {
    lines.push(`— 建不了账(零动作,逐条探针原因):`);
    for (const item of parts.unledgerable.slice(0, 8)) lines.push(`  · ${short(item.path)}: ${item.reasons[0]}`);
    if (parts.unledgerable.length > 8) lines.push(`  · …另 ${parts.unledgerable.length - 8} 项`);
  }
  if (parts.failed.length > 0) {
    lines.push(`— 失败/漂移/冲突(需人看,恢复指引在台账 lastError):`);
    for (const item of parts.failed) lines.push(`  · ${short(item.path)} [${item.lifecycle}] ${item.lastError ?? ''}`);
  }
  if (deferredNextRun.length > 0) lines.push(`— 运行中新增 ${deferredNextRun.length} 项,顺延下轮`);
  for (const alert of alerts) lines.push(`‼️ ${alert}`);
  return lines.join('\n');
}

const short = (path) => path.split('/').slice(-2).join('/');

function main() {
  const cmd = process.argv[2];

  if (cmd === 'hook') {
    // 纯只读判定,任何路径零写(D SC4)
    let state;
    try { state = readState(); } catch (error) { console.error(`[patrol] state 损坏: ${error.message}`); process.exit(1); }
    if (state.pending) { console.error('[patrol] 存在未确认 pending,继续报'); process.exit(0); }
    if (!state.lastGood) { console.error('[patrol] 无基线,首轮'); process.exit(0); }
    let config;
    try { config = loadConfig(CONFIG_PATH); } catch (error) { console.error(`[patrol] config 异常: ${error.message}`); process.exit(1); }
    if (config.configHash !== state.lastGood.configHash) { console.error('[patrol] config 指纹变化,重新裁决'); process.exit(0); }
    if (computeSourceHash() !== state.lastGood.sourceHash) { console.error('[patrol] 判定源码指纹变化,重新裁决'); process.exit(0); }
    let registryHash;
    try { registryHash = porcelainHashOf(MAIN_REPO); } catch (error) { console.error(`[patrol] 采集失败: ${error.message}`); process.exit(1); }
    if (registryHash !== state.lastGood.postHash) { console.error('[patrol] registry 有变化'); process.exit(0); }
    const deadline = state.lastGood.minDeadlineMs;
    if (typeof deadline === 'number' && nowMs() >= deadline) { console.error('[patrol] recent-loss 保护窗到期,重新裁决'); process.exit(0); }
    console.error('[patrol] 与已确认基线一致且无到期项,本轮跳过');
    process.exit(2);
  }

  if (cmd === 'report') {
    const alerts = [];
    let ok = true;
    // ① 建账(冻结 cohort)
    const boot = bootstrap({ repoDir: MAIN_REPO, configPath: CONFIG_PATH });
    const cohortEntryIds = Object.keys(boot.entries);
    // ② 存证 ③ 回收(单项失败不阻断,函数内部逐项 catch)
    const preserved = preserveAll({ repoDir: MAIN_REPO, configPath: CONFIG_PATH, opId: boot.runId });
    if (!preserved.ok) ok = false;
    const reclaimed = reclaimAll({ repoDir: MAIN_REPO, configPath: CONFIG_PATH });
    if (!reclaimed.ok) ok = false;
    // ④ post-reclaim 复采(pending.snapshot 的唯一合法来源,D SC1)
    const postHash = porcelainHashOf(MAIN_REPO);
    const ledger = readLedger();
    const { parts, missing } = partition(cohortEntryIds, ledger);
    if (missing.length > 0) { ok = false; alerts.push(`台账缺 ${missing.length} 个 cohort 项(分区并集破缺)`); }
    const unionSize = parts.reclaimed.length + parts.keep.length + parts.unledgerable.length + parts.failed.length;
    if (unionSize + missing.length !== cohortEntryIds.length) { ok = false; alerts.push('四分区并集 != cohort(互斥性破缺)'); }
    // ⑤ 受保护项消失检测:上一基线的 keep/unledgerable 路径,若本轮 cohort 缺失且
    //    不是本工具台账登记的 reclaimed(按 run 历史豁免)→ 报警(D SC5)
    const state = readState();
    if (state.lastGood) {
      const cohortPaths = new Set(Object.values(boot.entries).map((entry) => entry.evidence.literalPath));
      const reclaimedPaths = new Set(Object.values(ledger.entries).filter((entry) => entry.lifecycle === 'reclaimed').map((entry) => entry.evidence.literalPath));
      for (const item of [...(state.lastGood.parts?.keep ?? []), ...(state.lastGood.parts?.unledgerable ?? [])]) {
        if (!cohortPaths.has(item.path) && !reclaimedPaths.has(item.path)) {
          alerts.push(`受保护项消失: ${short(item.path)}(原 ${item.reasons?.[0] ?? '?'})——非本巡检授权的删除,请核`);
        }
      }
    }
    const minDeadlineMs = Math.min(...parts.keep.map((item) => item.deadlineMs ?? Infinity));
    const pending = {
      id: `p-${boot.runId}`,
      runId: boot.runId,
      cohortHash: boot.cohortHash,
      postHash,
      ledgerHash: ledgerHashOf(),
      sourceHash: boot.sourceHash,
      configHash: boot.config.configHash,
      minDeadlineMs: Number.isFinite(minDeadlineMs) ? minDeadlineMs : null,
      parts, ok,
      deferredNextRun: boot.deferredNextRun,
      alerts,
      createdAt: new Date(nowMs()).toISOString(),
    };
    writeStateAtomic({ ...readState(), schemaVersion: STATE_SCHEMA_VERSION, pending });
    console.log(`PENDING_ID=${pending.id}`);
    console.log(renderNotify({ runId: boot.runId, host: hostname(), parts, cohortSize: cohortEntryIds.length, deferredNextRun: boot.deferredNextRun, alerts, ok }));
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'ack') {
    const pendingId = process.argv[process.argv.indexOf('--pending') + 1];
    const state = readState();
    if (!state.pending) { console.error('无 pending 可确认'); process.exit(1); }
    if (state.pending.id !== pendingId) { console.error(`pending id 不符: 现存 ${state.pending.id}`); process.exit(1); }
    if (!state.pending.ok) { console.error('本轮含 failed/stale/conflict,拒绝晋升基线(次轮重试)'); process.exit(1); }
    // 绑定校验:ack 时刻的 registry 与台账必须仍是 run 结束时的形态(D SC1)
    const registryHash = porcelainHashOf(MAIN_REPO);
    if (registryHash !== state.pending.postHash) { console.error('registry 已漂移,pending 过期,拒绝 ack'); process.exit(1); }
    if (ledgerHashOf() !== state.pending.ledgerHash) { console.error('台账已漂移,pending 过期,拒绝 ack'); process.exit(1); }
    writeStateAtomic({
      schemaVersion: STATE_SCHEMA_VERSION,
      lastGood: {
        runId: state.pending.runId,
        postHash: state.pending.postHash,
        ledgerHash: state.pending.ledgerHash,
        sourceHash: state.pending.sourceHash,
        configHash: state.pending.configHash,
        minDeadlineMs: state.pending.minDeadlineMs,
        parts: state.pending.parts,
        ackedAt: new Date(nowMs()).toISOString(),
      },
      pending: null,
    });
    console.log(`已确认基线 run=${state.pending.runId}`);
    process.exit(0);
  }

  console.error('用法: worktree-patrol.mjs hook | report | ack --pending <id>');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
