#!/usr/bin/env node
// preserve — P0-B0 存证与恢复原语。职责:把每个 disposition=reclaim 的台账项变成
// 「删了也零损失」——immutable 归档 ref / bundle(隔离仓复验)/ stash 快照 / ignored
// 残渣归档,产出 receipt(一次写入不可覆盖)。**本模块禁止一切删除**:不调
// worktree remove/prune/fs.rm/branch -D;唯一的原工作树变更是 stash push(存证动作
// 本身,cindy 同款),且转存失败必须 apply 回去。
//
// 子命令:
//   preserve --repo <目标仓> [--config <path>] [--op <id>]   批量存证全部 reclaim 项
//   rehearse --receipt <path> --dest <dir>                   按 recoveryArgv 演练恢复+全等校验
//
// 故障注入(仅测试):PATROL_FAIL_GIT_SUBCMD=<subcmd> 由 git shim 消费;本模块不读它。

import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { KEEP_SENTINEL, parsePorcelainWorktrees } from './repo-worktrees-core.mjs';
import { GIT_ENV, git, tryGit } from './repo-worktrees.mjs';
import { sha256, canonicalize } from './ledger-core.mjs';
import {
  STATE_DIR, ledgerPath, readLedger, withLedgerLock, writeLedgerAtomic, loadConfig, computeSourceHash,
} from './ledger-bootstrap.mjs';
import { probeObservedLive } from './live-probe.mjs';

const MANIFEST_WALK_BUDGET = 300_000;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ── pre-state manifest(B0 SC1):除 .git 外每路径 类型/mode/size/sha256/链接目标 ──

export function computeManifest(worktreePath) {
  const rows = [];
  let budget = MANIFEST_WALK_BUDGET;
  const walk = (rel) => {
    if (budget-- <= 0) throw new Error('manifest 走查超预算');
    const abs = join(worktreePath, rel);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      rows.push({ path: rel, type: 'symlink', target: readlinkSync(abs) });
    } else if (stat.isDirectory()) {
      rows.push({ path: rel, type: 'dir', mode: stat.mode & 0o7777 });
      for (const name of readdirSync(abs)) {
        if (rel === '' && name === '.git') continue; // linked worktree 的 .git 指针文件/目录不入清单
        walk(rel === '' ? name : `${rel}/${name}`);
      }
    } else {
      rows.push({ path: rel, type: 'file', mode: stat.mode & 0o7777, size: stat.size, sha256: sha256File(abs) });
    }
  };
  walk('');
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const head = git(['-C', worktreePath, 'rev-parse', 'HEAD']);
  const statusRaw = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '--untracked-files=all'], {
    encoding: 'utf8', env: GIT_ENV, maxBuffer: 256 * 1024 * 1024,
  });
  const statusTokens = statusRaw.split('\0').filter(Boolean).sort();
  const manifestText = JSON.stringify(canonicalize({ head, rows, statusTokens }));
  return { head, rows, statusTokens, manifestHash: sha256(manifestText) };
}

export function manifestEqual(a, b) {
  return JSON.stringify(canonicalize({ rows: a.rows, statusTokens: a.statusTokens }))
    === JSON.stringify(canonicalize({ rows: b.rows, statusTokens: b.statusTokens }));
}

// ── 跨进程 repo 级锁(stash 栈共享,B0 SC3/SC6) ──────────────────────────────

function withRepoLock(commonDir, fn) {
  const lockDir = join(STATE_DIR(), 'locks');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, `stash-${sha256(commonDir).slice(0, 16)}.lock`);
  let fd = null;
  const started = Date.now();
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000; } catch { /* 竞争删除 */ }
      if (stale) { rmSync(lockPath, { force: true }); continue; }
      if (Date.now() - started > 30_000) throw new Error('repo stash 锁等待超时(并发实例?),fail-visible');
      execFileSync('sleep', ['0.2']);
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

// ── 存证原语 ────────────────────────────────────────────────────────────────

const ZERO_OID = '0'.repeat(40);

/** immutable 归档 ref:update-ref 带 expected-old=zero,已存在即拒绝覆盖(B0 SC2)。 */
function createArchiveRef(repoRoot, ref, sha) {
  execFileSync('git', ['-C', repoRoot, 'update-ref', ref, sha, ZERO_OID], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const readBack = git(['-C', repoRoot, 'rev-parse', ref]);
  if (readBack !== sha) throw new Error(`归档 ref 复读不符: ${readBack} != ${sha}`);
  return ref;
}

/** bundle 三步验证 + 隔离仓复验(无 alternates/无原仓 objects,B0 SC2)。 */
function createVerifiedBundle(repoRoot, ref, sha, bundlePath, mustContainShas) {
  execFileSync('git', ['-C', repoRoot, 'bundle', 'create', bundlePath, ref], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repoRoot, 'bundle', 'verify', bundlePath], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const heads = execFileSync('git', ['-C', repoRoot, 'bundle', 'list-heads', bundlePath], { encoding: 'utf8', env: GIT_ENV }).trim();
  if (!heads.split('\n').some((line) => line.startsWith(`${sha} `))) {
    throw new Error(`bundle list-heads 对账失败: 未含 ${sha}`);
  }
  const isolated = mkdtempSync(join(tmpdir(), 'patrol-bundle-check-'));
  try {
    execFileSync('git', ['init', '--bare', '--quiet', isolated], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', isolated, 'fetch', '--quiet', bundlePath, `${ref}:refs/check/head`], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const mustSha of mustContainShas) {
      execFileSync('git', ['-C', isolated, 'cat-file', '-e', `${mustSha}^{commit}`], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
  return { bundleSha256: sha256File(bundlePath), heads };
}

/** stash 快照:唯一 marker 精确定位(endsWith),转存 immutable ref,失败 apply 回滚(B0 SC3/SC5)。 */
function stashSnapshot(repoRoot, worktreePath, entryId, opId, preManifest) {
  const marker = `patrol-snapshot op=${opId} entry=${entryId}`;
  execFileSync('git', ['-C', worktreePath, 'stash', 'push', '--include-untracked', '-m', marker], {
    env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const locate = () => {
    const list = execFileSync('git', ['-C', worktreePath, 'stash', 'list', '--format=%H%x09%gs'], { encoding: 'utf8', env: GIT_ENV });
    return list.split('\n').filter(Boolean)
      .map((line) => { const [stashSha, ...rest] = line.split('\t'); return { sha: stashSha.trim(), subject: rest.join('\t') }; })
      .find((item) => item.subject.endsWith(marker))?.sha ?? null;
  };
  const revert = (stashSha) => {
    // 回滚到 pre-state:--index 恢复暂存区形态;回滚后必须 manifest 全等
    execFileSync('git', ['-C', worktreePath, 'stash', 'apply', '--index', stashSha], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const after = computeManifest(worktreePath);
    if (!manifestEqual(after, preManifest)) {
      throw new Error('mutated-but-preserved: stash 回滚后 manifest 与 pre-state 不全等,需人工恢复(快照仍在 stash 栈)');
    }
  };
  const stashSha = locate();
  if (!stashSha) throw new Error('preservation_failed: stash 条目按 marker 定位失败(内容可能留在 stash 栈)');
  const ref = `refs/patrol/snapshots/${entryId}/${opId}`;
  try {
    createArchiveRef(repoRoot, ref, stashSha);
  } catch (error) {
    revert(stashSha);
    throw new Error(`preservation_failed: snapshot ref 转存失败(${String(error.message).slice(0, 120)}),已回滚原工作树`);
  }
  // 转存成功后重跑完整损失探测:仍 dirty(stash 覆盖不到的形态)→ 回滚 + 拒绝进入删除层
  const residualStatus = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { encoding: 'utf8', env: GIT_ENV });
  const residualDirty = residualStatus.split('\0').filter(Boolean)
    .filter((token) => !(token.startsWith('? ') && token.slice(2) === KEEP_SENTINEL));
  if (residualDirty.length > 0) {
    revert(stashSha);
    throw new Error('unsupported-loss-shape: stash 后工作树仍 dirty(v1 无等价归档),已回滚,该项转 unledgerable');
  }
  return { snapshotRef: ref, snapshotSha: stashSha, marker };
}

/** ignored 残渣归档:tar + 逐文件 sha256 + 实际解包复验(B0 SC4)。 */
function residueArchive(worktreePath, ignoredPaths, destDir, residueMaxBytes) {
  const files = [];
  let total = 0;
  let budget = MANIFEST_WALK_BUDGET;
  const collect = (rel) => {
    if (budget-- <= 0) throw new Error('residue 走查超预算');
    const abs = join(worktreePath, rel);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) files.push({ path: rel, type: 'symlink', target: readlinkSync(abs) });
    else if (stat.isDirectory()) { for (const name of readdirSync(abs)) collect(`${rel}/${name}`); }
    else { total += stat.size; files.push({ path: rel, type: 'file', mode: stat.mode & 0o7777, size: stat.size, sha256: sha256File(abs) }); }
  };
  for (const raw of ignoredPaths) collect(raw.replace(/\/$/, ''));
  if (total > residueMaxBytes) {
    throw new Error(`preservation_failed: ignored 内容 ${total}B 超过 residueMaxBytes=${residueMaxBytes}(fail-closed 不删)`);
  }
  const listPath = join(destDir, 'residue-list.nul');
  writeFileSync(listPath, files.map((file) => file.path).join('\0'));
  const tarPath = join(destDir, 'residue.tar');
  execFileSync('tar', ['-c', '-f', tarPath, '-C', worktreePath, '--null', '-T', listPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 实际解包复验:逐文件 hash 全等
  const check = mkdtempSync(join(tmpdir(), 'patrol-residue-check-'));
  try {
    execFileSync('tar', ['-x', '-f', tarPath, '-C', check], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const file of files) {
      if (file.type === 'symlink') {
        if (readlinkSync(join(check, file.path)) !== file.target) throw new Error(`preservation_failed: residue 软链复验不符 ${file.path}`);
      } else if (sha256File(join(check, file.path)) !== file.sha256) {
        throw new Error(`preservation_failed: residue hash 复验不符 ${file.path}`);
      }
    }
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
  return { residuePath: tarPath, residueSha256: sha256File(tarPath), residueManifest: files };
}

// ── recoveryArgv(结构化,{DEST} 占位;可粘贴文本由 argv 安全转义生成,B0 SC6) ──

function shellQuote(token) {
  return `'${String(token).replace(/'/g, `'\\''`)}'`;
}

function buildRecovery({ repoRoot, head, snapshot, residue }) {
  const argv = [
    ['git', '-C', repoRoot, 'worktree', 'add', '--detach', '{DEST}', head],
  ];
  if (snapshot) argv.push(['git', '-C', '{DEST}', 'stash', 'apply', '--index', snapshot.snapshotSha]);
  if (residue) argv.push(['tar', '-x', '-f', residue.residuePath, '-C', '{DEST}']);
  const text = argv.map((cmd) => cmd.map((token) => (token === '{DEST}' ? '"$DEST"' : shellQuote(token))).join(' ')).join(' && ');
  return { recoveryArgv: argv, recoveryText: `DEST=<恢复目标目录>; ${text}` };
}

// ── preserve 主流程 ─────────────────────────────────────────────────────────

function receiptPath(entryId) { return join(STATE_DIR(), 'receipts', `${entryId}.json`); }

export function readReceipt(entryId) {
  const path = receiptPath(entryId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeReceiptOnce(entryId, receipt) {
  const path = receiptPath(entryId);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx'); // 一次写入;已存在即抛(immutable)
  try { writeSync(fd, `${JSON.stringify(canonicalize(receipt), null, 2)}\n`); } finally { closeSync(fd); }
}

/** preserve 前的守门重验(P0-C SC5):sentinel/locked/live/OPEN-PR/身份,任一命中即 skip。 */
function preflightGuards(entry, repoRoot, config) {
  const worktreePath = entry.evidence.literalPath;
  try {
    const real = realpathSync(worktreePath);
    if (real !== entry.evidence.realpath) return `stale: realpath 漂移 ${real}`;
  } catch (error) { return `stale: realpath 失败 ${error?.code}`; }
  try { lstatSync(join(worktreePath, KEEP_SENTINEL)); return 'keep: 哨兵已出现'; } catch (error) {
    if (error?.code !== 'ENOENT') return `keep: 哨兵探测 ${error?.code}(按存在保留)`;
  }
  const porcelain = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const item = parsePorcelainWorktrees(porcelain).find((it) => it.path === worktreePath);
  if (!item) return 'stale: registry 中已消失';
  if (item.locked) return 'keep: 已被 lock';
  const head = tryGit(['-C', worktreePath, 'rev-parse', 'HEAD']);
  if (head !== entry.evidence.head) return `stale: HEAD 漂移 ${head?.slice(0, 12)}`;
  const live = probeObservedLive(entry.evidence.realpath, config);
  if (live.result !== 'no-observed-live') return `keep: ${live.result}(${live.detail})`;
  return null;
}

export function preserveAll({ repoDir, configPath, opId }) {
  const config = loadConfig(configPath);
  const repoRoot = git(['rev-parse', '--show-toplevel'], { cwd: repoDir });
  const ledger = readLedger();
  const op = opId ?? `op-${Date.now().toString(36)}`;
  const outcomes = [];

  for (const entry of Object.values(ledger.entries)) {
    if (entry.disposition !== 'reclaim') continue;
    if (['preserved', 'removing', 'reclaimed'].includes(entry.lifecycle)) {
      const existing = readReceipt(entry.entryId);
      if (existing?.status === 'valid' && existing.preState.head === entry.evidence.head) {
        outcomes.push({ entryId: entry.entryId, path: entry.evidence.literalPath, outcome: 'already-preserved' });
        continue;
      }
    }
    const guard = preflightGuards(entry, repoRoot, config);
    if (guard) {
      outcomes.push({ entryId: entry.entryId, path: entry.evidence.literalPath, outcome: 'skipped', reason: guard });
      continue;
    }
    const worktreePath = entry.evidence.literalPath;
    const artifactDir = join(STATE_DIR(), 'preserve', entry.entryId, op);
    mkdirSync(artifactDir, { recursive: true });
    try {
      const preManifest = computeManifest(worktreePath);
      if (preManifest.head !== entry.evidence.head) throw new Error(`stale: manifest 期 HEAD 漂移`);
      const artifacts = {};
      const plan = entry.preservationPlan;
      const unreachable = plan.includes('bundle')
        ? git(['-C', worktreePath, 'rev-list', 'HEAD', '--not', '--remotes']).split('\n').filter(Boolean)
        : [];
      if (plan.includes('archive-ref')) {
        const ref = `refs/patrol/archive/${entry.entryId}/${op}`;
        artifacts.archiveRef = createArchiveRef(repoRoot, ref, preManifest.head);
        artifacts.archiveRefSha = preManifest.head;
      }
      if (plan.includes('bundle')) {
        Object.assign(artifacts, createVerifiedBundle(repoRoot, artifacts.archiveRef, preManifest.head, join(artifactDir, 'objects.bundle'), unreachable));
        artifacts.bundlePath = join(artifactDir, 'objects.bundle');
        artifacts.unreachableShas = unreachable.slice(0, 500);
      }
      // 顺序不变量:residue(纯只读)必须先于 stash(会改动工作树)——否则 residue
      // 失败时原工作树已被 stash 清空,违反 SC5「注入失败后 manifest 与 pre-state 全等」
      let residue = null;
      if (plan.includes('residue-archive')) {
        const ignoredRaw = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '--ignored=matching'], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
        const ignoredPaths = ignoredRaw.split('\0').filter((token) => token.startsWith('! ')).map((token) => token.slice(2));
        residue = residueArchive(worktreePath, ignoredPaths, artifactDir, config.residueMaxBytes);
        Object.assign(artifacts, residue);
      }
      let snapshot = null;
      if (plan.includes('stash-snapshot')) {
        snapshot = withRepoLock(ledger.commonDir ?? repoRoot, () => stashSnapshot(repoRoot, worktreePath, entry.entryId, op, preManifest));
        Object.assign(artifacts, snapshot);
      }
      const recovery = buildRecovery({ repoRoot, head: preManifest.head, snapshot, residue });
      const postStatus = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v2', '-z', '--untracked-files=all'], { encoding: 'utf8', env: GIT_ENV });
      const receipt = {
        schemaVersion: 1,
        entryId: entry.entryId,
        operationId: op,
        repoRoot,
        worktreePath,
        branch: entry.evidence.branch,
        detached: entry.evidence.detached,
        preState: { head: preManifest.head, manifestHash: preManifest.manifestHash, rows: preManifest.rows, statusTokens: preManifest.statusTokens },
        postPreserve: { statusTokens: postStatus.split('\0').filter(Boolean).sort(), head: preManifest.head },
        artifacts,
        ...recovery,
        configHash: config.configHash,
        sourceHash: computeSourceHash(),
        status: 'valid',
        createdAt: new Date().toISOString(),
      };
      writeReceiptOnce(entry.entryId, receipt);
      withLedgerLock(() => {
        const current = readLedger();
        current.entries[entry.entryId] = { ...current.entries[entry.entryId], lifecycle: 'preserved', receiptPath: receiptPath(entry.entryId), operationId: op };
        writeLedgerAtomic(current);
      });
      outcomes.push({ entryId: entry.entryId, path: worktreePath, outcome: 'preserved', receipt: receiptPath(entry.entryId) });
    } catch (error) {
      const message = String(error?.message ?? error);
      const kind = message.startsWith('unsupported-loss-shape') ? 'unledgerable'
        : message.startsWith('mutated-but-preserved') ? 'mutated-but-preserved'
          : message.startsWith('stale') ? 'stale' : 'preservation_failed';
      withLedgerLock(() => {
        const current = readLedger();
        const target = current.entries[entry.entryId];
        if (target) {
          if (kind === 'unledgerable') {
            current.entries[entry.entryId] = { ...target, disposition: 'unledgerable', lifecycle: 'terminal', reasons: [...target.reasons, message] };
          } else {
            current.entries[entry.entryId] = { ...target, lifecycle: kind === 'stale' ? 'stale' : 'preserve-failed', lastError: message };
          }
          writeLedgerAtomic(current);
        }
      });
      outcomes.push({ entryId: entry.entryId, path: worktreePath, outcome: kind, reason: message });
    }
  }
  const failed = outcomes.filter((outcome) => ['preservation_failed', 'mutated-but-preserved'].includes(outcome.outcome));
  return { op, outcomes, ok: failed.length === 0 };
}

// ── rehearse:按 recoveryArgv 演练恢复 + 全等校验(B0 SC1;P1-E SC2 消费) ──────

export function rehearse({ receiptPath: receiptFile, dest }) {
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (receipt.status !== 'valid') throw new Error(`receipt 状态非 valid: ${receipt.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  for (const argvTemplate of receipt.recoveryArgv) {
    const argv = argvTemplate.map((token) => (token === '{DEST}' ? dest : token));
    execFileSync(argv[0], argv.slice(1), { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const restored = computeManifest(dest);
  const equal = manifestEqual(restored, receipt.preState) && restored.head === receipt.preState.head;
  if (equal) {
    // 演练目录清理(只清演练自己的 worktree,不碰任何原工作树)
    execFileSync('git', ['-C', receipt.repoRoot, 'worktree', 'remove', '--force', dest], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, manifestHash: restored.manifestHash };
  }
  return { ok: false, reason: 'manifest/状态与 pre-state 不全等(演练现场保留供排查)', dest };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--repo') opt.repo = argv[++i];
    else if (argv[i] === '--config') opt.config = argv[++i];
    else if (argv[i] === '--op') opt.op = argv[++i];
    else if (argv[i] === '--receipt') opt.receipt = argv[++i];
    else if (argv[i] === '--dest') opt.dest = argv[++i];
    else { console.error(`未知参数: ${argv[i]}`); process.exit(2); }
  }
  if (cmd === 'preserve') {
    const result = preserveAll({ repoDir: opt.repo ?? process.cwd(), configPath: opt.config ?? join(import.meta.dirname, '..', 'config', 'patrol.config.json'), opId: opt.op });
    for (const outcome of result.outcomes) console.log(`- ${outcome.outcome.padEnd(20)} ${outcome.path}${outcome.reason ? ` | ${outcome.reason}` : ''}`);
    process.exit(result.ok ? 0 : 1);
  } else if (cmd === 'rehearse') {
    const result = rehearse({ receiptPath: opt.receipt, dest: opt.dest });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } else {
    console.error('用法: preserve.mjs preserve --repo <dir> [--config <p>] [--op <id>] | rehearse --receipt <p> --dest <dir>');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
