#!/usr/bin/env node
// reclaim — P0-B 删除器。只消费「schema-valid + config/source hash 匹配 +
// disposition=reclaim + receipt 复读验证通过」的台账项;缺任一条件都不删。
// 唯一破坏性动作是 `git worktree remove <path>`(**无 --force**,git 自身的 dirty
// 拒绝是最后一道天然闸);禁 fs.rm / worktree prune / unlock / branch|ref 删除。
//
// 每项删除路径:receipt 复验 → 身份重验×2 → durable removing intent(先落账) →
// 末刻重验(status/HEAD/sentinel/locked/live) → remove → 后验(registry+FS 双缺) → 记账。
// 四象限(B SC4):双在且全等→可删;FS缺registry在→stale(零 prune);FS在registry缺→
// conflict(零删除);双缺→仅当已有 removing intent + valid receipt 才收敛 reclaimed。

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { KEEP_SENTINEL, parsePorcelainWorktrees } from './repo-worktrees-core.mjs';
import { GIT_ENV, git, tryGit, loadPrLookup, parseRepoSlug } from './repo-worktrees.mjs';
import {
  STATE_DIR, readLedger, withLedgerLock, writeLedgerAtomic, loadConfig, computeSourceHash,
} from './ledger-bootstrap.mjs';
import { readReceipt } from './preserve.mjs';
import { probeObservedLive } from './live-probe.mjs';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ── receipt 复读验证(B SC1):不信台账转述,逐 artifact 重验 ───────────────────

function verifyReceipt(entry, repoRoot) {
  const receipt = readReceipt(entry.entryId);
  if (!receipt) return { error: 'receipt 不存在' };
  if (receipt.status !== 'valid') return { error: `receipt 状态 ${receipt.status}` };
  if (receipt.preState.head !== entry.evidence.head) return { error: 'receipt HEAD 与台账不符' };
  if (receipt.worktreePath !== entry.evidence.literalPath) return { error: 'receipt 路径与台账不符' };
  const artifacts = receipt.artifacts ?? {};
  if (artifacts.archiveRef) {
    const sha = tryGit(['-C', repoRoot, 'rev-parse', artifacts.archiveRef]);
    if (sha !== artifacts.archiveRefSha) return { error: `归档 ref 复读不符: ${sha?.slice(0, 12)}` };
  }
  if (artifacts.bundlePath) {
    if (!existsSync(artifacts.bundlePath)) return { error: 'bundle 文件缺失' };
    if (sha256File(artifacts.bundlePath) !== artifacts.bundleSha256) return { error: 'bundle sha256 不符' };
  }
  if (artifacts.snapshotRef) {
    const sha = tryGit(['-C', repoRoot, 'rev-parse', artifacts.snapshotRef]);
    if (sha !== artifacts.snapshotSha) return { error: `snapshot ref 复读不符: ${sha?.slice(0, 12)}` };
  }
  if (artifacts.residuePath) {
    if (!existsSync(artifacts.residuePath)) return { error: 'residue 归档缺失' };
    if (sha256File(artifacts.residuePath) !== artifacts.residueSha256) return { error: 'residue sha256 不符' };
  }
  return { receipt };
}

// ── 身份重验(B SC2):allowed-root 边界/无软链祖先/porcelain 精确块/receipt 全等 ──

function identityCheck(entry, receipt, repoRoot, commonDirReal, config, prSummary) {
  const literalPath = entry.evidence.literalPath;
  // realpath == 字面路径(蕴含全链无软链祖先) + allowed-root 前缀含分隔符边界
  let real;
  try { real = realpathSync(literalPath); } catch (error) { return `realpath 失败: ${error?.code}`; }
  if (real !== literalPath) return `realpath(${real}) != 字面路径(软链祖先或路径漂移)`;
  if (!config.allowedRoots.some((root) => real === root || real.startsWith(`${root}/`))) {
    return 'realpath 不在 allowedRoots 内';
  }
  let stat;
  try { stat = lstatSync(literalPath); } catch (error) { return `lstat 失败: ${error?.code}`; }
  if (!stat.isDirectory()) return `lstat 非目录`;
  // porcelain 整行精确匹配块
  const porcelain = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const items = parsePorcelainWorktrees(porcelain);
  const item = items.find((it) => it.path === literalPath);
  if (!item) return 'registry 中无精确匹配块';
  if (!porcelain.split('\n').includes(`worktree ${literalPath}`)) return 'porcelain 无整行精确匹配';
  // primary 禁删:porcelain 首项即主 checkout
  if (items[0]?.path === literalPath) return '目标是 primary checkout';
  if (item.locked) return '已 locked';
  if (item.prunable) return 'registry 已标 prunable(目录态与登记冲突)';
  if (item.detached !== entry.evidence.detached) return 'detached 态漂移';
  const branch = item.detached ? null : (item.branchRef ?? '').replace(/^refs\/heads\//, '') || null;
  if (branch !== entry.evidence.branch) return `branch 漂移: ${branch}`;
  if (item.head !== receipt.preState.head) return `HEAD 漂移: ${item.head?.slice(0, 12)}`;
  // worktree 自认身份
  const gitDir = tryGit(['-C', literalPath, 'rev-parse', '--path-format=absolute', '--git-dir']);
  if (gitDir === null) return 'rev-parse --git-dir 失败';
  const wtCommon = tryGit(['-C', literalPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (wtCommon === null) return 'rev-parse --git-common-dir 失败';
  let wtCommonReal = wtCommon;
  try { wtCommonReal = realpathSync(wtCommon); } catch { /* 词法值参与比较,必然不等即报 */ }
  if (wtCommonReal !== commonDirReal) return `commonDir 漂移: ${wtCommonReal}`;
  // 哨兵三态(除 ENOENT 外一律按存在)
  try { lstatSync(join(literalPath, KEEP_SENTINEL)); return '哨兵已出现'; } catch (error) {
    if (error?.code !== 'ENOENT') return `哨兵探测 ${error?.code}(按存在保留)`;
  }
  // OPEN PR 重验(分支名 / detached OID 双通道)
  if (prSummary.status !== 'ok') return `PR 通道不完整(${prSummary.reason}),负证据不可得`;
  if (branch && prSummary.openHeadRefNames.includes(branch)) return 'OPEN PR(分支)出现';
  if (item.detached && prSummary.openHeadOids.includes(item.head)) return 'OPEN PR(detached OID)出现';
  return null;
}

/** 末刻重验:紧邻 remove 前。工作树必须 clean(忽略 ignored;哨兵已在身份检查覆盖)+ live 探针。 */
function finalProbe(entry, receipt, config) {
  const literalPath = entry.evidence.literalPath;
  const head = tryGit(['-C', literalPath, 'rev-parse', 'HEAD']);
  if (head !== receipt.preState.head) return `末刻 HEAD 漂移: ${head?.slice(0, 12)}`;
  let statusRaw;
  try {
    statusRaw = execFileSync('git', ['-C', literalPath, 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
  } catch { return '末刻 status 失败'; }
  const dirtyTokens = statusRaw.split('\0').filter(Boolean)
    .filter((token) => !(token.startsWith('? ') && token.slice(2) === KEEP_SENTINEL));
  if (dirtyTokens.length > 0) return `末刻发现 ${dirtyTokens.length} 条未存证变更(tracked/untracked)`;
  const live = probeObservedLive(entry.evidence.realpath, config);
  if (live.result !== 'no-observed-live') return `末刻探活: ${live.result}(${live.detail})`;
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function setEntry(entryId, patch) {
  return withLedgerLock(() => {
    const ledger = readLedger();
    const target = ledger.entries[entryId];
    if (!target) throw new Error(`台账无此项: ${entryId}`);
    ledger.entries[entryId] = { ...target, ...patch };
    writeLedgerAtomic(ledger);
    return ledger.entries[entryId];
  });
}

export function reclaimAll({ repoDir, configPath }) {
  const config = loadConfig(configPath);
  const sourceHash = computeSourceHash();
  const repoRoot = git(['rev-parse', '--show-toplevel'], { cwd: repoDir });
  const commonDirReal = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot }));
  const repoSlug = parseRepoSlug(tryGit(['-C', repoRoot, 'remote', 'get-url', 'origin']));
  const prLookup = loadPrLookup(repoRoot, repoSlug);
  const prSummary = {
    status: prLookup.status, reason: prLookup.reason ?? null,
    openHeadRefNames: prLookup.openHeadRefNames ?? [], openHeadOids: prLookup.openHeadOids ?? [],
  };
  const ledger = readLedger();
  const outcomes = [];

  for (const entry of Object.values(ledger.entries)) {
    if (entry.disposition !== 'reclaim') continue;
    const literalPath = entry.evidence.literalPath;
    const record = (outcome, reason) => outcomes.push({ entryId: entry.entryId, path: literalPath, outcome, ...(reason ? { reason } : {}) });

    try {
      if (entry.lifecycle === 'reclaimed') { record('already_reclaimed'); continue; }

      // 四象限先判(B SC4)
      const registryHas = parsePorcelainWorktrees(git(['worktree', 'list', '--porcelain'], { cwd: repoRoot }))
        .some((item) => item.path === literalPath);
      const fsHas = existsSync(literalPath);
      if (!fsHas && registryHas) {
        setEntry(entry.entryId, { lifecycle: 'stale', lastError: 'stale-registry: FS 缺 registry 在(v1 零 prune)' });
        record('stale', 'stale-registry: FS 缺 registry 在(v1 零 prune)');
        continue;
      }
      if (fsHas && !registryHas) {
        setEntry(entry.entryId, { lifecycle: 'conflict', lastError: 'path-reused: FS 在 registry 缺(零文件删除)' });
        record('conflict', 'path-reused: FS 在 registry 缺(零文件删除)');
        continue;
      }
      if (!fsHas && !registryHas) {
        if (entry.lifecycle === 'removing' && verifyReceipt(entry, repoRoot).receipt) {
          setEntry(entry.entryId, { lifecycle: 'reclaimed', reclaimedAt: new Date().toISOString(), crashReconciled: true });
          record('reclaimed', 'crash-reconcile: removing intent + valid receipt,双缺收敛');
        } else {
          setEntry(entry.entryId, { lifecycle: 'stale', lastError: '双缺但无 removing intent,不得当 already_reclaimed' });
          record('stale', '双缺但无 removing intent,不得当 already_reclaimed');
        }
        continue;
      }

      // 消费前置:hash 匹配 + receipt 复读(B SC1)
      if (entry.lifecycle !== 'preserved' && entry.lifecycle !== 'removing') { record('skipped', `lifecycle=${entry.lifecycle},未完成存证`); continue; }
      if (entry.configHash !== config.configHash) { record('failed', 'configHash 不匹配(配置已变,需重新建账)'); continue; }
      if (entry.sourceHash !== sourceHash) { record('failed', 'sourceHash 不匹配(判定源码已变,需重新建账)'); continue; }
      const verified = verifyReceipt(entry, repoRoot);
      if (verified.error) { setEntry(entry.entryId, { lifecycle: 'preserve-failed', lastError: `receipt 复读失败: ${verified.error}` }); record('failed', `receipt 复读失败: ${verified.error}`); continue; }
      const { receipt } = verified;

      // 身份重验 ×2(同进程连续两次,B SC2/SC3 第二窗口)
      for (const round of [1, 2]) {
        const problem = identityCheck(entry, receipt, repoRoot, commonDirReal, config, prSummary);
        if (problem) throw { kind: 'stale', message: `身份重验#${round}: ${problem}` };
      }

      // durable removing intent 先落账(B SC5)
      setEntry(entry.entryId, { lifecycle: 'removing', intentAt: new Date().toISOString() });

      // 末刻重验(B SC3 第三窗口入口)
      const lastProblem = finalProbe(entry, receipt, config);
      if (lastProblem) throw { kind: 'stale', message: `末刻重验: ${lastProblem}` };

      // 唯一破坏性动作:无 --force;git 自身对 dirty 的拒绝是天然最后闸
      try {
        execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', literalPath], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        throw { kind: 'failed', message: `worktree remove 被拒(不自动升级 --force): ${String(error?.stderr ?? error?.message).slice(0, 200)}` };
      }

      // 后验:registry + FS 双缺
      const stillRegistered = parsePorcelainWorktrees(git(['worktree', 'list', '--porcelain'], { cwd: repoRoot }))
        .some((item) => item.path === literalPath);
      if (stillRegistered || existsSync(literalPath)) {
        throw { kind: 'failed', message: `remove 后仍存在: registry=${stillRegistered} fs=${existsSync(literalPath)}` };
      }
      setEntry(entry.entryId, { lifecycle: 'reclaimed', reclaimedAt: new Date().toISOString() });
      record('reclaimed');
    } catch (thrown) {
      const kind = thrown?.kind ?? 'failed';
      const message = String(thrown?.message ?? thrown).slice(0, 300);
      try { setEntry(entry.entryId, { lifecycle: kind === 'stale' ? 'stale' : 'reclaim-failed', lastError: message }); } catch { /* 台账写失败也要出报告 */ }
      record(kind, message);
    }
  }

  const bad = outcomes.filter((outcome) => ['failed', 'stale', 'conflict'].includes(outcome.outcome));
  return { outcomes, ok: bad.length === 0, counts: countBy(outcomes) };
}

function countBy(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.outcome] = (counts[outcome.outcome] ?? 0) + 1;
  return counts;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') opt.repo = argv[++i];
    else if (argv[i] === '--config') opt.config = argv[++i];
    else { console.error(`未知参数: ${argv[i]}`); process.exit(2); }
  }
  const result = reclaimAll({
    repoDir: opt.repo ?? process.cwd(),
    configPath: opt.config ?? join(import.meta.dirname, '..', 'config', 'patrol.config.json'),
  });
  for (const outcome of result.outcomes) {
    console.log(`- ${outcome.outcome.padEnd(18)} ${outcome.path}${outcome.reason ? ` | ${outcome.reason}` : ''}`);
  }
  console.log(JSON.stringify({ counts: result.counts, ok: result.ok }));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
