// reclaim 测试:P0-B 删除器(共识 SC1..SC7)。
// 每个场景独立小仓(reclaim 会清掉一切合格项,共享仓会互相摧毁 fixture)。
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOOTSTRAP = join(import.meta.dirname, '..', 'scripts', 'ledger-bootstrap.mjs');
const PRESERVE = join(import.meta.dirname, '..', 'scripts', 'preserve.mjs');
const RECLAIM = join(import.meta.dirname, '..', 'scripts', 'reclaim.mjs');
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const NOW_MS = Date.now() + 100 * 24 * 3600 * 1000;

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trimEnd();
}

const roots = [];
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

// 场景仓工厂:bare origin + work + 按 spec 建 worktree
// spec: { name: 'clean'|'unpushed'|'dirty'|'detdirty'|'sentinel'|'locked'|'pr' }
function makeRepo(specs) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'reclaim-')));
  roots.push(tmp);
  const origin = join(tmp, 'origin.git');
  const work = join(tmp, 'work');
  sh(tmp, GIT_BIN, ['init', '--bare', '--initial-branch=main', origin]);
  sh(tmp, GIT_BIN, ['clone', origin, work]);
  sh(work, GIT_BIN, ['config', 'user.email', 'f@x.invalid']);
  sh(work, GIT_BIN, ['config', 'user.name', 'f']);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  writeFileSync(join(work, '.gitignore'), '*.ign\n');
  sh(work, GIT_BIN, ['add', '.']);
  sh(work, GIT_BIN, ['commit', '-m', 'init']);
  sh(work, GIT_BIN, ['push', '-u', 'origin', 'main']);
  sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/o/r.git']);

  const paths = {};
  for (const spec of specs) {
    const wt = join(tmp, `wt-${spec.name}`);
    paths[spec.name] = wt;
    if (spec.kind === 'detdirty') {
      sh(work, GIT_BIN, ['worktree', 'add', '--detach', wt]);
      writeFileSync(join(wt, 'x.txt'), 'x\n');
      continue;
    }
    sh(work, GIT_BIN, ['worktree', 'add', wt, '-b', `f-${spec.name}`]);
    if (spec.kind === 'unpushed') {
      writeFileSync(join(wt, 'u.txt'), 'u\n');
      sh(wt, GIT_BIN, ['add', '.']); sh(wt, GIT_BIN, ['commit', '-m', 'up']);
    } else if (spec.kind === 'dirty') {
      writeFileSync(join(wt, 'd.txt'), 'd\n');
    } else if (spec.kind === 'sentinel') {
      writeFileSync(join(wt, 'd.txt'), 'd\n');
      writeFileSync(join(wt, '.worktree-keep'), '');
    } else if (spec.kind === 'locked') {
      sh(work, GIT_BIN, ['worktree', 'lock', '--reason', 'fixture', wt]);
    } else if (spec.kind === 'pr') {
      // PR 分支必须有独立提交:否则 headRefOid == main tip,会连带命中所有
      // 游离在 tip 上的 fixture(detached-OID 门按设计就该那样判)
      writeFileSync(join(wt, 'pr.txt'), 'pr\n');
      sh(wt, GIT_BIN, ['add', '.']); sh(wt, GIT_BIN, ['commit', '-m', 'pr-only']);
    }
    // kind === 'clean': 建在已推 tip,无额外动作
  }

  // shims:git(注入钩) + gh(rows 文件驱动) + lsof(none)
  const shimDir = join(tmp, 'shim-bin');
  mkdirSync(shimDir);
  const gitLog = join(tmp, 'git.log');
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
echo "$*" >> "${gitLog}"
if [ -n "$PATROL_FAIL_GIT" ]; then
  case "$*" in *"$PATROL_FAIL_GIT"*) exit 42;; esac
fi
if [ -n "$PATROL_SABOTAGE_REMOVE_TARGET" ]; then
  case "$*" in *"worktree remove"*)
    touch "$PATROL_SABOTAGE_REMOVE_TARGET/injected-final-window.txt"
    ;;
  esac
fi
if [ -n "$PATROL_SABOTAGE_STATUS_TARGET" ] && [ ! -f "$PATROL_SABOTAGE_STATUS_TARGET/.sabotaged" ]; then
  case "$*" in *"$PATROL_SABOTAGE_STATUS_TARGET"*"status --porcelain=v2"*|*"status --porcelain=v2"*"$PATROL_SABOTAGE_STATUS_TARGET"*)
    touch "$PATROL_SABOTAGE_STATUS_TARGET/injected-mid-window.txt"
    touch "$PATROL_SABOTAGE_STATUS_TARGET/.sabotaged"
    ;;
  esac
fi
exec "${GIT_BIN}" "$@"
`);
  chmodSync(join(shimDir, 'git'), 0o755);
  const ghRows = join(tmp, 'gh-rows.json');
  writeFileSync(ghRows, '[]');
  writeFileSync(join(shimDir, 'gh'), `#!/bin/sh\ncat "${ghRows}"\n`);
  chmodSync(join(shimDir, 'gh'), 0o755);
  const lsofStub = join(tmp, 'lsof-stub');
  writeFileSync(lsofStub, '#!/bin/sh\nexit 1\n');
  chmodSync(lsofStub, 0o755);
  const configPath = join(tmp, 'patrol.config.json');
  writeFileSync(configPath, JSON.stringify({ thresholdHours: 48, allowedRoots: [tmp], residueMaxBytes: 1 << 30, lsofBin: lsofStub, lsofTimeoutMs: 5000 }));
  const stateDir = join(tmp, 'state');
  const env = { ...process.env, PATH: `${shimDir}:/usr/bin:/bin`, PATROL_NOW_MS: String(NOW_MS), WORKTREE_PATROL_STATE_DIR: stateDir };
  const run = (script, args, extraEnv = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, ...extraEnv },
  });
  const repo = {
    tmp, work, paths, configPath, stateDir, gitLog, ghRows,
    run,
    bootstrap: (extraEnv) => run(BOOTSTRAP, ['--repo', work, '--config', configPath, '--json'], extraEnv),
    preserve: (op, extraEnv) => run(PRESERVE, ['preserve', '--repo', work, '--config', configPath, '--op', op ?? 'op-r'], extraEnv),
    reclaim: (extraEnv) => run(RECLAIM, ['--repo', work, '--config', configPath], extraEnv),
    ledger: () => JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8')),
    entryByPath: (suffix) => Object.values(JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8')).entries)
      .find((entry) => entry.evidence.literalPath.endsWith(suffix)),
    registryPaths: () => sh(work, GIT_BIN, ['worktree', 'list', '--porcelain']).split('\n')
      .filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)),
    writeGitCalls: () => readFileSync(gitLog, 'utf8').split('\n').filter(Boolean).filter((line) => {
      const tokens = line.split(' ');
      let i = 0;
      while (tokens[i] === '-C') i += 2;
      const sub = tokens[i];
      if (['stash', 'update-ref', 'bundle', 'branch', 'push', 'commit'].includes(sub)) return true;
      return sub === 'worktree' && ['remove', 'prune', 'unlock', 'lock', 'move', 'add'].includes(tokens[i + 1]);
    }),
  };
  return repo;
}

function outcomesOf(result) {
  const tail = result.stdout.trim().split('\n').at(-1);
  return { counts: JSON.parse(tail).counts, ok: JSON.parse(tail).ok, stdout: result.stdout };
}

describe('reclaim(P0-B)', () => {
  it('happy path:四类合格项删除,keep 类零动作;二跑全 already_reclaimed 且零写(B SC1/SC5/SC6)', { timeout: 300_000 }, () => {
    const repo = makeRepo([
      { name: 'clean', kind: 'clean' }, { name: 'unpushed', kind: 'unpushed' },
      { name: 'dirty', kind: 'dirty' }, { name: 'detdirty', kind: 'detdirty' },
      { name: 'sentinel', kind: 'sentinel' }, { name: 'locked', kind: 'locked' }, { name: 'pr', kind: 'pr' },
    ]);
    // f-pr 有在途 PR(建账时即 keep)
    const prHead = sh(repo.paths.pr, GIT_BIN, ['rev-parse', 'HEAD']);
    writeFileSync(repo.ghRows, JSON.stringify([{ headRefName: 'f-pr', headRefOid: prHead, number: 1, state: 'OPEN', isDraft: false, title: 'p', url: 'https://x.invalid/1', isCrossRepository: false }]));

    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status, 'preserve').toBe(0);
    const keepDirsBefore = ['sentinel', 'locked', 'pr'].map((name) => sh(repo.paths[name], GIT_BIN, ['status', '--porcelain']));

    const first = repo.reclaim();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const { counts } = outcomesOf(first);
    expect(counts.reclaimed).toBe(4);

    // 四类已从 registry + FS 消失
    const registry = repo.registryPaths();
    for (const name of ['clean', 'unpushed', 'dirty', 'detdirty']) {
      expect(existsSync(repo.paths[name]), name).toBe(false);
      expect(registry.includes(repo.paths[name]), name).toBe(false);
    }
    // keep 类原样(目录在/registry 在/status 不变)
    ['sentinel', 'locked', 'pr'].forEach((name, index) => {
      expect(existsSync(repo.paths[name]), name).toBe(true);
      expect(registry.includes(repo.paths[name]), name).toBe(true);
      expect(sh(repo.paths[name], GIT_BIN, ['status', '--porcelain'])).toBe(keepDirsBefore[index]);
    });
    // 分支永不删:被清项的分支仍在
    const branches = sh(repo.work, GIT_BIN, ['branch', '--list']).replace(/[* ]/g, '').split('\n');
    for (const branch of ['f-clean', 'f-unpushed', 'f-dirty']) expect(branches).toContain(branch);

    // 二跑:全 already_reclaimed,git 写命令数 0
    rmSync(repo.gitLog, { force: true });
    const second = repo.reclaim();
    expect(second.status).toBe(0);
    expect(outcomesOf(second).counts.already_reclaimed).toBe(4);
    expect(repo.writeGitCalls()).toEqual([]);
  });

  it('身份/守门重验:存证后出现 哨兵/lock/OPEN-PR → 零删除(B SC2 + P0-C SC5)', { timeout: 300_000 }, () => {
    const repo = makeRepo([
      { name: 's1', kind: 'clean' }, { name: 's2', kind: 'clean' }, { name: 's3', kind: 'clean' },
    ]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    // 存证后、删除前:s1 放哨兵,s2 上锁,s3 冒出 OPEN PR
    writeFileSync(join(repo.paths.s1, '.worktree-keep'), '');
    sh(repo.work, GIT_BIN, ['worktree', 'lock', '--reason', 'late', repo.paths.s2]);
    const s3Head = sh(repo.paths.s3, GIT_BIN, ['rev-parse', 'HEAD']);
    writeFileSync(repo.ghRows, JSON.stringify([{ headRefName: 'f-s3', headRefOid: s3Head, number: 9, state: 'OPEN', isDraft: false, title: 'l', url: 'https://x.invalid/9', isCrossRepository: false }]));

    const result = repo.reclaim();
    expect(result.status).not.toBe(0); // stale 属 fail-visible
    const { counts } = outcomesOf(result);
    expect(counts.reclaimed ?? 0).toBe(0);
    for (const name of ['s1', 's2', 's3']) {
      expect(existsSync(repo.paths[name]), name).toBe(true);
      expect(repo.registryPaths().includes(repo.paths[name]), name).toBe(true);
    }
  });

  it('TOCTOU 末窗口:remove 紧邻前注入文件 → git 自身拒绝,failed+保留(B SC3 窗口③)', { timeout: 300_000 }, () => {
    const repo = makeRepo([{ name: 'w3', kind: 'clean' }]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    const result = repo.reclaim({ PATROL_SABOTAGE_REMOVE_TARGET: repo.paths.w3 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('worktree remove 被拒');
    expect(existsSync(repo.paths.w3)).toBe(true);
    expect(existsSync(join(repo.paths.w3, 'injected-final-window.txt'))).toBe(true);
    expect(repo.registryPaths().includes(repo.paths.w3)).toBe(true);
  });

  it('TOCTOU 中窗口:两次身份验后、末刻 status 前注入 → stale+保留(B SC3 窗口②)', { timeout: 300_000 }, () => {
    const repo = makeRepo([{ name: 'w2', kind: 'clean' }]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    const result = repo.reclaim({ PATROL_SABOTAGE_STATUS_TARGET: repo.paths.w2 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/末刻|stale/);
    expect(existsSync(repo.paths.w2)).toBe(true);
    expect(existsSync(join(repo.paths.w2, 'injected-mid-window.txt'))).toBe(true);
    expect(repo.registryPaths().includes(repo.paths.w2)).toBe(true);
  });

  it('四象限:stale-registry / path-reused / 双缺有 intent / 双缺无 intent(B SC4/SC5)', { timeout: 300_000 }, () => {
    const repo = makeRepo([
      { name: 'q1', kind: 'clean' }, { name: 'q2', kind: 'clean' },
      { name: 'q3', kind: 'clean' }, { name: 'q4', kind: 'clean' },
    ]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    // q1: FS 缺 registry 在
    rmSync(repo.paths.q1, { recursive: true, force: true });
    // q2: FS 在 registry 缺(手动 remove 后原地重建普通目录)
    sh(repo.work, GIT_BIN, ['worktree', 'remove', '--force', repo.paths.q2]);
    mkdirSync(repo.paths.q2);
    writeFileSync(join(repo.paths.q2, 'reused.txt'), 'r\n');
    // q3: 双缺 + removing intent(模拟 remove 成功后、记账前崩溃)
    const ledgerPath = join(repo.stateDir, 'ledger.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const q3Entry = Object.values(ledger.entries).find((entry) => entry.evidence.literalPath === repo.paths.q3);
    ledger.entries[q3Entry.entryId] = { ...q3Entry, lifecycle: 'removing', intentAt: new Date().toISOString() };
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    sh(repo.work, GIT_BIN, ['worktree', 'remove', '--force', repo.paths.q3]);
    // q4: 双缺、无 intent
    sh(repo.work, GIT_BIN, ['worktree', 'remove', '--force', repo.paths.q4]);

    rmSync(repo.gitLog, { force: true });
    const result = repo.reclaim();
    expect(result.status).not.toBe(0); // q1/q4 stale + q2 conflict → fail-visible
    const entries = repo.ledger().entries;
    const byPath = (path) => Object.values(entries).find((entry) => entry.evidence.literalPath === path);
    expect(byPath(repo.paths.q1).lifecycle).toBe('stale');
    expect(repo.registryPaths().includes(repo.paths.q1)).toBe(true); // 零 prune
    expect(byPath(repo.paths.q2).lifecycle).toBe('conflict');
    expect(existsSync(join(repo.paths.q2, 'reused.txt'))).toBe(true); // 零文件删除
    expect(byPath(repo.paths.q3).lifecycle).toBe('reclaimed');
    expect(byPath(repo.paths.q3).crashReconciled).toBe(true);
    expect(byPath(repo.paths.q4).lifecycle).toBe('stale'); // 不得当 already_reclaimed
    // crash-reconcile 不重复存证:本轮无 stash/update-ref/bundle 写
    expect(repo.writeGitCalls().filter((line) => !/worktree (remove|prune)/.test(line))).toEqual([]);
  });

  it('receipt 篡改 / config 漂移 / source 漂移 → 拒绝消费,零删除(B SC1)', { timeout: 300_000 }, () => {
    const repo = makeRepo([{ name: 't1', kind: 'unpushed' }]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    const entry = repo.entryByPath('wt-t1');
    const receiptFile = join(repo.stateDir, 'receipts', `${entry.entryId}.json`);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));

    // ① 篡改 bundle hash
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, artifacts: { ...receipt.artifacts, bundleSha256: 'f'.repeat(64) } }, null, 2));
    let result = repo.reclaim();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('receipt 复读失败');
    expect(existsSync(repo.paths.t1)).toBe(true);

    // 恢复 receipt + lifecycle,② config 漂移
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    const ledgerPath = join(repo.stateDir, 'ledger.json');
    const ledger = repo.ledger();
    ledger.entries[entry.entryId] = { ...ledger.entries[entry.entryId], lifecycle: 'preserved', lastError: null };
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const cfg2 = join(repo.tmp, 'cfg2.json');
    writeFileSync(cfg2, JSON.stringify({ thresholdHours: 47, allowedRoots: [repo.tmp], residueMaxBytes: 1 << 30, lsofBin: join(repo.tmp, 'lsof-stub'), lsofTimeoutMs: 5000 }));
    result = repo.run(RECLAIM, ['--repo', repo.work, '--config', cfg2]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('configHash 不匹配');
    expect(existsSync(repo.paths.t1)).toBe(true);

    // ③ source 漂移:伪造 entry.sourceHash
    const ledger3 = repo.ledger();
    ledger3.entries[entry.entryId] = { ...ledger3.entries[entry.entryId], sourceHash: 'e'.repeat(64), lifecycle: 'preserved' };
    writeFileSync(ledgerPath, JSON.stringify(ledger3, null, 2));
    result = repo.reclaim();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('sourceHash 不匹配');
    expect(existsSync(repo.paths.t1)).toBe(true);
  });

  it('hostile env:GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* 注入指向诱饵仓 → 只动目标仓(B SC7)', { timeout: 300_000 }, () => {
    const repo = makeRepo([{ name: 'h1', kind: 'clean' }]);
    // 诱饵仓
    const decoy = join(repo.tmp, 'decoy');
    sh(repo.tmp, GIT_BIN, ['init', '--initial-branch=main', decoy]);
    sh(decoy, GIT_BIN, ['config', 'user.email', 'd@x.invalid']);
    sh(decoy, GIT_BIN, ['config', 'user.name', 'd']);
    writeFileSync(join(decoy, 'z.txt'), 'z\n');
    sh(decoy, GIT_BIN, ['add', '.']); sh(decoy, GIT_BIN, ['commit', '-m', 'decoy']);
    const decoySnapshot = () => `${sh(decoy, GIT_BIN, ['rev-parse', 'HEAD'])}|${sh(decoy, GIT_BIN, ['status', '--porcelain'])}|${sh(decoy, GIT_BIN, ['stash', 'list'])}`;
    const before = decoySnapshot();
    const hostile = {
      GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no',
    };
    expect(repo.bootstrap(hostile).status).toBe(0);
    expect(repo.preserve('op-h', hostile).status).toBe(0);
    const result = repo.reclaim(hostile);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(outcomesOf(result).counts.reclaimed).toBe(1);
    expect(existsSync(repo.paths.h1)).toBe(false);
    expect(decoySnapshot()).toBe(before); // 诱饵仓分毫未动
  });

  it('反向变异:台账伪造指向 primary 的 reclaim 项 → 拒绝且零删除(B SC7)', { timeout: 300_000 }, () => {
    const repo = makeRepo([{ name: 'm1', kind: 'clean' }]);
    expect(repo.bootstrap().status).toBe(0);
    expect(repo.preserve().status).toBe(0);
    // 把 m1 的台账项文字替换成指向主仓根(receipt 校验/身份门必须拦住)
    const ledgerPath = join(repo.stateDir, 'ledger.json');
    const ledger = repo.ledger();
    const entry = Object.values(ledger.entries).find((item) => item.evidence.literalPath === repo.paths.m1);
    ledger.entries[entry.entryId] = JSON.parse(JSON.stringify(entry).replaceAll(repo.paths.m1, repo.work));
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const result = repo.reclaim();
    expect(result.status).not.toBe(0);
    expect(existsSync(repo.work)).toBe(true);
    expect(existsSync(join(repo.work, 'a.txt'))).toBe(true);
    expect(repo.registryPaths().includes(repo.work)).toBe(true);
  });
});
