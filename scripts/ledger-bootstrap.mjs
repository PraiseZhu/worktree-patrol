#!/usr/bin/env node
// ledger-bootstrap — P0-A 建账器:冻结 cohort → 逐项探针 → 策略裁决 → 原子写台账。
// 全程对目标仓**只读**(测试用 PATH shim 断言零写命令);唯一写入是 patrol 自己的
// state/ledger.json(O_EXCL 锁 + tmp/rename)。
//
// 用法: node scripts/ledger-bootstrap.mjs --repo <目标仓> [--config <path>] [--json]
// 注入: PATROL_NOW_MS(测试时钟) / WORKTREE_PATROL_STATE_DIR / REPO_WORKTREES_GH_TIMEOUT_MS

import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePorcelainWorktrees, KEEP_SENTINEL } from './repo-worktrees-core.mjs';
import { GIT_ENV, git, tryGit, loadPrLookup, parseRepoSlug } from './repo-worktrees.mjs';
import {
  LEDGER_SCHEMA_VERSION, canonicalize, computeActivity, decideDisposition,
  deriveEntryId, sha256, validateConfig,
} from './ledger-core.mjs';
import { probeObservedLive } from './live-probe.mjs';

const TOOL_ROOT = join(import.meta.dirname, '..');
export const STATE_DIR = () => process.env.WORKTREE_PATROL_STATE_DIR || join(TOOL_ROOT, 'state');
const LOSS_PATH_MTIME_WALK_BUDGET = 200_000;

// source fingerprint 覆盖面(P1-D SC5):判定逻辑任一文件变化都要触发重裁决
const SOURCE_FILES = [
  'scripts/repo-worktrees-core.mjs', 'scripts/repo-worktrees.mjs', 'scripts/ledger-core.mjs',
  'scripts/ledger-bootstrap.mjs', 'scripts/live-probe.mjs', 'scripts/preserve.mjs',
  'scripts/reclaim.mjs', 'scripts/worktree-patrol.mjs',
];

export function computeSourceHash() {
  const parts = [];
  for (const rel of SOURCE_FILES) {
    const p = join(TOOL_ROOT, rel);
    parts.push(`${rel}\0${existsSync(p) ? sha256(readFileSync(p, 'utf8')) : 'absent'}`);
  }
  return sha256(parts.join('\n'));
}

export function loadConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const checked = validateConfig(raw);
  if (!checked.ok) {
    throw new Error(`config 非法,整轮拒绝 reclaim: ${checked.errors.join('; ')}`);
  }
  // allowedRoots realpath 归一(/tmp 是 /private/tmp 的软链):归一失败的 root 保留
  // 词法原值——它此后匹配不到任何 realpath,等价于该 root 不生效,方向安全。
  const roots = checked.config.allowedRoots.map((root) => {
    try { return realpathSync(root); } catch { return root; }
  });
  return { ...checked.config, allowedRoots: roots, configHash: sha256(JSON.stringify(canonicalize(raw))) };
}

const underRoot = (realPath, roots) => roots.some((root) => realPath === root || realPath.startsWith(`${root}/`));

// ── 探针 ────────────────────────────────────────────────────────────────────

function lstatType(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return { type: 'dir', mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) return { type: 'symlink', mtimeMs: stat.mtimeMs };
    return { type: 'other', mtimeMs: stat.mtimeMs };
  } catch (error) {
    return error?.code === 'ENOENT' ? { type: 'missing' } : { type: `error:${error?.code ?? 'unknown'}` };
  }
}

function probeKeepSentinel(worktreePath) {
  try {
    lstatSync(join(worktreePath, KEEP_SENTINEL));
    return 'present';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : `error:${error?.code ?? 'unknown'}`;
  }
}

// status --porcelain=v2 解析 → loss manifest + 涉及路径清单。
// -z 分隔;行型: '1 <XY> <sub> ...' 变更 / '2 <XY> <sub> ... <path><sep><orig>' 重命名 /
// 'u ' 冲突 / '? <path>' 未跟踪 / '! <path>' 被忽略。
function probeLoss(worktreePath) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'],
      { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    return { error: `git status v2 失败: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const loss = {
    staged: 0, unstaged: 0, untracked: 0, ignored: 0,
    submoduleDirty: false, nestedRepos: 0, unreachableCommits: 0, detachedUnanchored: false,
  };
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const kind = token[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const fields = token.split(' ');
      const xy = fields[1] ?? '..';
      const sub = fields[2] ?? 'N...';
      // porcelain v2 路径起始字段随行型不同:'1'=第 9 个字段(index 8)、'2'=index 9
      // (多一个 <X><score>)、'u'=index 10;路径可含空格故 slice+join(-z 下行内不转义)
      const pathIndex = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const p = fields.slice(pathIndex).join(' ');
      if (p && p !== KEEP_SENTINEL) paths.push(p);
      if (xy[0] !== '.') loss.staged += 1;
      if (xy[1] !== '.') loss.unstaged += 1;
      if (sub[0] === 'S' && (sub.includes('C') || sub.includes('M') || sub.includes('U'))) loss.submoduleDirty = true;
      if (kind === '2') i += 1; // rename 的 origPath 是下一个 \0 token,跳过
    } else if (kind === '?') {
      const p = token.slice(2);
      if (p === KEEP_SENTINEL) continue; // 哨兵不算损失(与巡检器口径一致)
      loss.untracked += 1;
      paths.push(p);
      if (p.endsWith('/')) {
        // -uall 下仍以目录形态出现的未跟踪项 = git 不下潜的嵌套仓(或边界形态)——查 .git
        const inner = lstatType(join(worktreePath, p, '.git'));
        if (inner.type !== 'missing') loss.nestedRepos += 1;
      }
    } else if (kind === '!') {
      loss.ignored += 1;
      paths.push(token.slice(2));
    }
  }
  return { loss, paths };
}

// loss 涉及路径的最大 mtime:目录项(如 node_modules/)递归下潜,预算封顶,
// 超预算/任一 stat 失败 → error(fail-closed:「不知道多新」不能当「够旧」)。
function maxMtimeOfPaths(worktreePath, paths) {
  let max = -Infinity;
  let budget = LOSS_PATH_MTIME_WALK_BUDGET;
  let probed = 0;
  const walk = (abs) => {
    if (budget <= 0) throw new Error('mtime 走查超预算');
    budget -= 1;
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      // 删除类损失(worktree 侧 delete)在 status 里有路径但磁盘上已无实体——
      // ENOENT 不是探针故障,该路径没有 mtime 可测(删除时点由父目录/root mtime 承载),
      // 跳过;其余错误(权限等)仍 fail-closed。
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    probed += 1;
    if (stat.mtimeMs > max) max = stat.mtimeMs;
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name));
    }
  };
  try {
    for (const rel of paths) walk(join(worktreePath, rel.replace(/\/$/, '')));
  } catch (error) {
    return { error: `loss 路径 mtime 探测失败: ${String(error?.message ?? error).slice(0, 160)}` };
  }
  return { maxMtimeMs: probed === 0 ? null : max, probed };
}

function prSummaryHasOpenPr(prSummary, evidence) {
  if (prSummary.status !== 'ok') return false;
  if (!evidence.detached && evidence.branch) return prSummary.openHeadRefNames.includes(evidence.branch);
  if (evidence.detached && evidence.head) return prSummary.openHeadOids.includes(evidence.head);
  return false;
}

function probeEntry(entry, context) {
  const { commonDirReal, config, index } = context;
  const probeErrors = [];
  const literalPath = entry.path;
  const stat = lstatType(literalPath);

  const evidence = {
    literalPath,
    porcelainBlock: entry.raw ?? null,
    porcelainBlockHash: sha256(entry.raw ?? JSON.stringify(entry)),
    repoRoot: context.repoRoot,
    commonDir: commonDirReal,
    lstatType: stat.type,
    realpath: null,
    gitDir: null,
    head: entry.head ?? null,
    branch: entry.detached ? null : (entry.branchRef ?? '').replace(/^refs\/heads\//, '') || null,
    detached: Boolean(entry.detached),
    locked: Boolean(entry.locked),
    lockedReason: entry.lockedReason ?? null,
    prunable: Boolean(entry.prunable),
    isPrimary: index === 0,
    keepSentinel: null,
    underAllowedRoot: false,
    prLookup: context.prSummary,
    loss: null,
    activity: null,
    probeErrors,
  };

  // 目录不在/形态异常:后续探针全部跳过,由策略层按 stale-registry/异常处置
  if (stat.type !== 'dir') {
    evidence.keepSentinel = 'absent';
    evidence.loss = { staged: 0, unstaged: 0, untracked: 0, ignored: 0, submoduleDirty: false, nestedRepos: 0, unreachableCommits: 0, detachedUnanchored: false };
    evidence.activity = { activityAt: 0, evidence: [{ source: 'fs-missing', valueMs: 0 }] };
    evidence.realpath = literalPath;
    evidence.gitDir = 'absent';
    evidence.head = evidence.head ?? 'absent';
    return evidence;
  }

  try {
    evidence.realpath = realpathSync(literalPath);
  } catch (error) {
    probeErrors.push(`realpath 失败: ${error?.code ?? error}`);
  }
  if (evidence.realpath) evidence.underAllowedRoot = underRoot(evidence.realpath, config.allowedRoots);

  const gitDir = tryGit(['-C', literalPath, 'rev-parse', '--path-format=absolute', '--git-dir']);
  if (gitDir === null) probeErrors.push('rev-parse --git-dir 失败');
  else evidence.gitDir = gitDir;

  // 身份绑定:该 worktree 自认的 common-dir 必须就是本 cohort 的 commonDir
  const wtCommon = tryGit(['-C', literalPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (wtCommon === null) probeErrors.push('rev-parse --git-common-dir 失败');
  else {
    let wtCommonReal = wtCommon;
    try { wtCommonReal = realpathSync(wtCommon); } catch { /* 保留词法值,下一行必然不等 → 记错 */ }
    if (wtCommonReal !== commonDirReal) probeErrors.push(`commonDir 不一致: ${wtCommonReal} != ${commonDirReal}(串仓)`);
  }

  // primary 身份双验:porcelain 首项 + 仓根 realpath 等值(共识风险 1:不按 branch 名)
  if (evidence.isPrimary && evidence.realpath) {
    let rootReal = context.repoRoot;
    try { rootReal = realpathSync(context.repoRoot); } catch { /* 用词法值参与比较 */ }
    if (evidence.realpath !== rootReal) probeErrors.push(`primary 身份不一致: porcelain 首项 ${evidence.realpath} != 仓根 ${rootReal}`);
  }

  evidence.keepSentinel = probeKeepSentinel(literalPath);

  const lossProbe = probeLoss(literalPath);
  if (lossProbe.error) {
    probeErrors.push(lossProbe.error);
    evidence.loss = { staged: 0, unstaged: 0, untracked: 0, ignored: 0, submoduleDirty: null, nestedRepos: 0, unreachableCommits: 0, detachedUnanchored: false };
  } else {
    evidence.loss = lossProbe.loss;
    evidence.lossPaths = lossProbe.paths.slice(0, 64); // 台账里只留样本,完整清单不落账
    const unreachable = tryGit(['-C', literalPath, 'rev-list', '--count', 'HEAD', '--not', '--remotes']);
    if (unreachable === null) probeErrors.push('rev-list --not --remotes 失败');
    else evidence.loss.unreachableCommits = Number.parseInt(unreachable, 10) || 0;
    if (evidence.detached) {
      const unanchored = tryGit(['-C', literalPath, 'rev-list', '--count', 'HEAD', '--not', '--all', '--remotes']);
      if (unanchored === null) probeErrors.push('rev-list --not --all --remotes 失败');
      else evidence.loss.detachedUnanchored = (Number.parseInt(unanchored, 10) || 0) > 0;
    }
    // activity 三来源(P0-C SC3)。硬保留门必命中的项(主仓根/哨兵/locked/在途 PR)
    // 走不到 recent-loss 判定,跳过 loss 路径 mtime 走查——主仓根是活仓库,走查它
    // 既慢又必然逐轮漂移(实测 run 间唯一 diff 源),跳过后 evidence 仍诚实
    // (lossPathsProbed=false 如实记录未测)。
    const headCt = tryGit(['-C', literalPath, 'log', '-1', '--format=%ct']);
    const headCommitMs = headCt === null ? null : Number.parseInt(headCt, 10) * 1000;
    const hardKeepCertain = evidence.isPrimary
      || evidence.keepSentinel === 'present'
      || evidence.locked
      || (prSummaryHasOpenPr(context.prSummary, evidence));
    const mtimeProbe = (lossProbe.paths.length > 0 && !hardKeepCertain)
      ? maxMtimeOfPaths(literalPath, lossProbe.paths)
      : { maxMtimeMs: null };
    if (mtimeProbe.error) probeErrors.push(mtimeProbe.error);
    const activity = computeActivity({
      headCommitMs,
      rootMtimeMs: stat.mtimeMs ?? null,
      lossPathsMaxMtimeMs: mtimeProbe.maxMtimeMs,
      // probed=0(全部损失路径都是删除类)时无 mtime 可贡献,按未探处理
      lossPathsProbed: (mtimeProbe.probed ?? 0) > 0 && !hardKeepCertain && !mtimeProbe.error,
    });
    if (activity.error) {
      probeErrors.push(activity.error);
      evidence.activity = { activityAt: 0, evidence: [{ source: 'error', valueMs: 0 }] };
    } else {
      evidence.activity = activity;
    }
  }
  return evidence;
}

// ── 台账原子写(P0-A SC5) ────────────────────────────────────────────────────

export function ledgerPath() { return join(STATE_DIR(), 'ledger.json'); }

export function readLedger() {
  const path = ledgerPath();
  if (!existsSync(path)) return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`ledger schemaVersion 不符: ${parsed.schemaVersion}`);
  }
  return parsed;
}

/** O_EXCL 原子锁:openSync('wx') 内核级互斥,两并发写者至多一个成功(另一个 fail-visible)。 */
export function withLedgerLock(fn) {
  mkdirSync(STATE_DIR(), { recursive: true });
  const lockPath = join(STATE_DIR(), 'ledger.lock');
  let fd = null;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000; } catch { /* 竞争删除,按未过期处理 */ }
      if (stale) {
        rmSync(lockPath, { force: true });
        return withLedgerLock(fn);
      }
      throw new Error('ledger.lock 被占用(并发实例?),本轮 fail-visible 放弃');
    }
    throw error;
  }
  try {
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export function writeLedgerAtomic(ledger) {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(canonicalize(ledger), null, 2)}\n`);
  renameSync(tmp, path);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

export function bootstrap({ repoDir, configPath, nowMs }) {
  const config = loadConfig(configPath);
  const sourceHash = computeSourceHash();
  const now = nowMs ?? Number(process.env.PATROL_NOW_MS || Date.now());

  const repoRoot = git(['rev-parse', '--show-toplevel'], { cwd: repoDir });
  const commonDirRaw = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot });
  const commonDirReal = realpathSync(commonDirRaw);

  // ① 冻结 cohort:porcelain 原文 + hash + run_id(P0-A SC1)
  const porcelainRaw = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const cohortHash = sha256(porcelainRaw);
  const runId = `r-${now.toString(36)}-${cohortHash.slice(0, 8)}`;
  const entries = parsePorcelainWorktrees(porcelainRaw);

  // porcelain 块原文按条切开(entry 顺序与 parse 一致:worktree 行为界)
  const rawBlocks = porcelainRaw.split(/\n\n+/).filter((block) => block.trim().length > 0);
  entries.forEach((entry, i) => { entry.raw = rawBlocks[i] ?? null; });

  const repoSlug = parseRepoSlug(tryGit(['-C', repoRoot, 'remote', 'get-url', 'origin']));
  const prLookup = loadPrLookup(repoRoot, repoSlug);
  const prSummary = {
    status: prLookup.status,
    reason: prLookup.reason ?? null,
    openHeadRefNames: prLookup.openHeadRefNames ?? [],
    openHeadOids: prLookup.openHeadOids ?? [],
  };

  // ② 逐项探针 + 两阶段裁决(reclaim 候选才跑 lsof)
  const decidedEntries = {};
  for (let i = 0; i < entries.length; i++) {
    const evidence = probeEntry(entries[i], { commonDirReal, repoRoot, config, prSummary, index: i });
    let verdict = decideDisposition(evidence, config, now, null);
    let liveProbe = null;
    if (verdict.requiresLiveProbe) {
      const probe = probeObservedLive(evidence.realpath, config);
      liveProbe = probe;
      verdict = decideDisposition(evidence, config, now, probe.result);
    }
    const entryId = deriveEntryId(commonDirReal, evidence.literalPath);
    decidedEntries[entryId] = {
      entryId,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      evidence,
      liveProbe,
      disposition: verdict.disposition,
      reasons: verdict.reasons,
      preservationPlan: verdict.preservationPlan ?? [],
      deadlineMs: verdict.deadlineMs ?? null,
      lifecycle: verdict.disposition === 'reclaim' ? 'decided' : 'terminal',
      configHash: config.configHash,
      sourceHash,
      runId,
      recordedAt: new Date(now).toISOString(),
    };
  }

  // ③ deferred-next-run:处理期间新出现的注册项不混入本 cohort(P0-A SC1)
  const postRaw = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const postPaths = parsePorcelainWorktrees(postRaw).map((entry) => entry.path);
  const cohortPaths = new Set(entries.map((entry) => entry.path));
  const deferredNextRun = postPaths.filter((path) => !cohortPaths.has(path));

  // ④ canonical upsert(不盲 append):同 entryId 覆盖为最新裁决,消失项保留历史
  const result = withLedgerLock(() => {
    const ledger = readLedger();
    ledger.targetRepo = repoRoot;
    ledger.commonDir = commonDirReal;
    for (const [entryId, entry] of Object.entries(decidedEntries)) {
      const prev = ledger.entries[entryId];
      // 已 reclaimed/removing 的终态不被新一轮"看不见了"的重扫覆盖(B 层负责推进)
      if (prev && ['removing', 'reclaimed'].includes(prev.lifecycle)) continue;
      ledger.entries[entryId] = { ...entry, firstSeenRunId: prev?.firstSeenRunId ?? entry.runId };
    }
    writeLedgerAtomic(ledger);
    return ledger;
  });

  const counts = { reclaim: 0, keep: 0, unledgerable: 0 };
  for (const entry of Object.values(decidedEntries)) counts[entry.disposition] += 1;

  return {
    runId, cohortHash, porcelainRaw, repoRoot, commonDir: commonDirReal,
    repoSlug, prLookup: prSummary, config, sourceHash,
    cohortSize: entries.length, counts, deferredNextRun,
    entries: decidedEntries, ledger: result,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = { repo: process.cwd(), config: join(TOOL_ROOT, 'config', 'patrol.config.json'), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') opt.repo = argv[++i];
    else if (argv[i] === '--config') opt.config = argv[++i];
    else if (argv[i] === '--json') opt.json = true;
    else { console.error(`未知参数: ${argv[i]}`); process.exit(2); }
  }
  const out = bootstrap({ repoDir: opt.repo, configPath: opt.config });
  if (opt.json) {
    process.stdout.write(`${JSON.stringify({ ...out, ledger: undefined, porcelainRaw: undefined }, null, 2)}\n`);
    return;
  }
  console.log(`run ${out.runId} cohort=${out.cohortSize} reclaim=${out.counts.reclaim} keep=${out.counts.keep} unledgerable=${out.counts.unledgerable} deferred=${out.deferredNextRun.length}`);
  for (const entry of Object.values(out.entries)) {
    console.log(`- ${entry.disposition.padEnd(12)} ${entry.evidence.literalPath}`);
    for (const reason of entry.reasons.slice(0, 2)) console.log(`    · ${reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
