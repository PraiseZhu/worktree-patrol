// preserve 测试:P0-B0 存证与恢复原语(共识 SC1..SC6)。
// 全部走 CLI + PATH shim(git 故障可注入),每场景独立 state dir。
// 时钟技巧:PATROL_NOW_MS = 真实 now + 100 天 → fixture 全部"够老",免逐个 backdate。
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeManifest, manifestEqual } from '../scripts/preserve.mjs';

const BOOTSTRAP = join(import.meta.dirname, '..', 'scripts', 'ledger-bootstrap.mjs');
const PRESERVE = join(import.meta.dirname, '..', 'scripts', 'preserve.mjs');
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const NOW_MS = Date.now() + 100 * 24 * 3600 * 1000; // 全体 fixture 相对该"现在"都超过 48h

function sh(cwd, cmd, args, env) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env }).trimEnd();
}

describe('preserve E2E(fixture 仓)', () => {
  let tmp; let work; let shimDir; let lsofStub; let configPath; let env;
  const SPACY = "wt sp'ace"; // 空格+单引号路径(B0 SC6)

  function runNode(script, args, extraEnv = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, ...extraEnv },
    });
  }

  function bootstrapTo(stateDir) {
    const result = runNode(BOOTSTRAP, ['--repo', work, '--config', configPath, '--json'], { WORKTREE_PATROL_STATE_DIR: stateDir });
    expect(result.status, result.stderr).toBe(0);
    return result;
  }

  function preserveTo(stateDir, extraEnv = {}) {
    return runNode(PRESERVE, ['preserve', '--repo', work, '--config', configPath, '--op', 'op-test'], { WORKTREE_PATROL_STATE_DIR: stateDir, ...extraEnv });
  }

  function ledgerOf(stateDir) {
    return JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8'));
  }

  function entryByPath(entries, suffix) {
    return Object.values(entries).find((entry) => entry.evidence.literalPath.endsWith(suffix));
  }

  function receiptOf(stateDir, entryId) {
    return JSON.parse(readFileSync(join(stateDir, 'receipts', `${entryId}.json`), 'utf8'));
  }

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'preserve-')));
    const origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    configPath = join(tmp, 'patrol.config.json');
    lsofStub = join(tmp, 'lsof-stub');
    sh(tmp, GIT_BIN, ['init', '--bare', '--initial-branch=main', origin]);
    sh(tmp, GIT_BIN, ['clone', origin, work]);
    sh(work, GIT_BIN, ['config', 'user.email', 'f@x.invalid']);
    sh(work, GIT_BIN, ['config', 'user.name', 'f']);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    writeFileSync(join(work, '.gitignore'), '*.ign\nignored-*\n');
    sh(work, GIT_BIN, ['add', '.']);
    sh(work, GIT_BIN, ['commit', '-m', 'init']);
    sh(work, GIT_BIN, ['push', '-u', 'origin', 'main']);
    sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/o/r.git']);

    // ① clean merged(建在已推 tip,零损失,plan=[])
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-clean'), '-b', 'f-clean']);
    // ② unpushed 多提交+merge commit
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-unpushed'), '-b', 'f-up']);
    const up = join(tmp, 'wt-unpushed');
    writeFileSync(join(up, 'u1.txt'), '1\n');
    sh(up, GIT_BIN, ['add', '.']); sh(up, GIT_BIN, ['commit', '-m', 'c1']);
    sh(up, GIT_BIN, ['checkout', '-b', 'f-up-side', 'HEAD~1']);
    writeFileSync(join(up, 'u2.txt'), '2\n');
    sh(up, GIT_BIN, ['add', '.']); sh(up, GIT_BIN, ['commit', '-m', 'c2']);
    sh(up, GIT_BIN, ['checkout', 'f-up']);
    sh(up, GIT_BIN, ['merge', '--no-ff', '-m', 'merge side', 'f-up-side']);
    // ③ detached + 本地独有提交(unanchored)
    sh(work, GIT_BIN, ['worktree', 'add', '--detach', join(tmp, 'wt-det')]);
    const det = join(tmp, 'wt-det');
    writeFileSync(join(det, 'd.txt'), 'd\n');
    sh(det, GIT_BIN, ['add', '.']); sh(det, GIT_BIN, ['commit', '-m', 'detached-only']);
    // ④ dirty 全形态:staged新增/unstaged修改/rename/delete/untracked(含前导短横线)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-dirty'), '-b', 'f-dirty']);
    const dirty = join(tmp, 'wt-dirty');
    writeFileSync(join(dirty, 'staged-new.txt'), 's\n');
    sh(dirty, GIT_BIN, ['add', 'staged-new.txt']);
    writeFileSync(join(dirty, 'a.txt'), 'a-modified\n');           // unstaged 修改
    sh(dirty, GIT_BIN, ['mv', 'b.txt', 'b-renamed.txt']);          // rename(staged)
    rmSync(join(dirty, '.gitignore'));                              // delete(unstaged)
    writeFileSync(join(dirty, '-dash.txt'), 'dash\n');              // untracked 前导短横线
    // ⑤ detached-dirty
    sh(work, GIT_BIN, ['worktree', 'add', '--detach', join(tmp, 'wt-detdirty')]);
    writeFileSync(join(tmp, 'wt-detdirty', 'x.txt'), 'x\n');
    // ⑥ ignored 三形态:普通/可执行位/软链
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-ign'), '-b', 'f-ign']);
    const ign = join(tmp, 'wt-ign');
    writeFileSync(join(ign, 'plain.ign'), 'p\n');
    writeFileSync(join(ign, 'exec.ign'), '#!/bin/sh\n');
    chmodSync(join(ign, 'exec.ign'), 0o755);
    symlinkSync('plain.ign', join(ign, 'link.ign'));
    // ⑦ 空格+单引号路径 + dirty
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, SPACY), '-b', 'f-spacy']);
    writeFileSync(join(tmp, SPACY, 'sp file.txt'), 'sp\n');
    // ⑧ 两个并发 snapshot 对照(同仓不同 worktree,均 dirty)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-c1'), '-b', 'f-c1']);
    writeFileSync(join(tmp, 'wt-c1', 'c1.txt'), '1\n');
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-c2'), '-b', 'f-c2']);
    writeFileSync(join(tmp, 'wt-c2', 'c2.txt'), '2\n');

    // shims
    shimDir = join(tmp, 'shim-bin');
    mkdirSync(shimDir);
    // git shim:PATROL_FAIL_GIT 非空且 "$*" 含该子串 → exit 42(故障注入,B0 SC5)
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh
if [ -n "$PATROL_FAIL_GIT" ]; then
  case "$*" in *"$PATROL_FAIL_GIT"*) exit 42;; esac
fi
exec "${GIT_BIN}" "$@"
`);
    chmodSync(join(shimDir, 'git'), 0o755);
    writeFileSync(join(shimDir, 'gh'), '#!/bin/sh\necho "[]"\n');
    chmodSync(join(shimDir, 'gh'), 0o755);
    writeFileSync(lsofStub, '#!/bin/sh\nexit 1\n');
    chmodSync(lsofStub, 0o755);
    writeFileSync(configPath, JSON.stringify({
      thresholdHours: 48, allowedRoots: [tmp], residueMaxBytes: 1 << 30, lsofBin: lsofStub, lsofTimeoutMs: 5000,
    }));
    env = {
      ...process.env,
      PATH: `${shimDir}:/usr/bin:/bin`,
      PATROL_NOW_MS: String(NOW_MS),
    };
  }, 120_000);

  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('全形态存证+恢复演练:manifest 逐字段全等(B0 SC1/SC2/SC3/SC4/SC6)', { timeout: 300_000 }, () => {
    const stateDir = join(tmp, 'st-main');
    bootstrapTo(stateDir);
    const entries = ledgerOf(stateDir).entries;
    // 前置:核对各场景 disposition 与 plan
    const expectPlan = (suffix, plan) => {
      const entry = entryByPath(entries, suffix);
      expect(entry, suffix).toBeTruthy();
      expect(entry.disposition, `${suffix}: ${JSON.stringify(entry?.reasons)}`).toBe('reclaim');
      expect(entry.preservationPlan).toEqual(plan);
      return entry;
    };
    expectPlan('wt-clean', []);
    expectPlan('wt-unpushed', ['archive-ref', 'bundle']);
    expectPlan('wt-det', ['archive-ref', 'bundle']);
    expectPlan('wt-dirty', ['stash-snapshot']);
    expectPlan('wt-detdirty', ['archive-ref', 'stash-snapshot']); // 游离在已推 tip:无本地独有提交,不需 bundle
    expectPlan('wt-ign', ['residue-archive']);
    expectPlan(SPACY, ['stash-snapshot']);

    // 存证前抓 pre-state(与 receipt 对照)
    const preDirty = computeManifest(join(tmp, 'wt-dirty'));

    const result = preserveTo(stateDir);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    // 每个 reclaim 项都有 valid receipt
    const after = ledgerOf(stateDir).entries;
    const reclaims = Object.values(after).filter((entry) => entry.disposition === 'reclaim');
    for (const entry of reclaims) {
      expect(entry.lifecycle, entry.evidence.literalPath).toBe('preserved');
      const receipt = receiptOf(stateDir, entry.entryId);
      expect(receipt.status).toBe('valid');
      expect(receipt.preState.head).toBe(entry.evidence.head);
    }
    // receipt 的 preState 与独立计算一致(dirty 项)
    const dirtyEntry = entryByPath(after, 'wt-dirty');
    const dirtyReceipt = receiptOf(stateDir, dirtyEntry.entryId);
    expect(dirtyReceipt.preState.manifestHash).toBe(preDirty.manifestHash);
    // 存证后原 dirty 工作树已 clean(stash 生效),快照 ref 复读 == stash sha
    expect(sh(join(tmp, 'wt-dirty'), GIT_BIN, ['status', '--porcelain'])).toBe('');
    const refSha = sh(work, GIT_BIN, ['rev-parse', dirtyReceipt.artifacts.snapshotRef]);
    expect(refSha).toBe(dirtyReceipt.artifacts.snapshotSha);

    // 恢复演练:四类逐个 rehearse → manifest 全等(B0 SC1)
    for (const suffix of ['wt-clean', 'wt-unpushed', 'wt-det', 'wt-dirty', 'wt-detdirty', 'wt-ign', SPACY]) {
      const entry = entryByPath(after, suffix);
      const dest = join(tmp, 'rehearse', entry.entryId);
      const rehearsed = runNode(PRESERVE, ['rehearse', '--receipt', join(stateDir, 'receipts', `${entry.entryId}.json`), '--dest', dest]);
      expect(rehearsed.status, `${suffix}: ${rehearsed.stdout}${rehearsed.stderr}`).toBe(0);
      expect(JSON.parse(rehearsed.stdout).ok).toBe(true);
    }

    // ignored 三形态确认进了 residue 清单(可执行位/软链目标保真由 rehearse 全等背书)
    const ignEntry = entryByPath(after, 'wt-ign');
    const ignReceipt = receiptOf(stateDir, ignEntry.entryId);
    const residuePaths = ignReceipt.artifacts.residueManifest.map((file) => file.path).sort();
    expect(residuePaths).toEqual(['exec.ign', 'link.ign', 'plain.ign']);
    expect(ignReceipt.artifacts.residueManifest.find((file) => file.path === 'exec.ign').mode & 0o111).toBeTruthy();
    expect(ignReceipt.artifacts.residueManifest.find((file) => file.path === 'link.ign').target).toBe('plain.ign');

    // bundle 隔离仓复验已在 preserve 内完成;此处对账 receipt 记录了 unreachable shas
    const upEntry = entryByPath(after, 'wt-unpushed');
    const upReceipt = receiptOf(stateDir, upEntry.entryId);
    expect(upReceipt.artifacts.unreachableShas.length).toBeGreaterThanOrEqual(3); // c1+c2+merge
    // 归档 ref 名绑定 entry_id+op,不含分支名(防同名分支复用覆盖,B0 SC2)
    expect(upReceipt.artifacts.archiveRef).toBe(`refs/patrol/archive/${upEntry.entryId}/op-test`);

    // 并发对照:两 dirty 项 snapshot ref/sha 互异,stash 栈两条都在(不自动 drop,B0 SC6)
    const c1 = receiptOf(stateDir, entryByPath(after, 'wt-c1').entryId);
    const c2 = receiptOf(stateDir, entryByPath(after, 'wt-c2').entryId);
    expect(c1.artifacts.snapshotSha).not.toBe(c2.artifacts.snapshotSha);
    expect(c1.artifacts.snapshotRef).not.toBe(c2.artifacts.snapshotRef);
    const stashList = sh(work, GIT_BIN, ['stash', 'list']);
    expect(stashList.split('\n').filter((line) => line.includes('patrol-snapshot')).length).toBeGreaterThanOrEqual(2);

    // recoveryText 由 argv 安全转义生成(含空格/引号路径的项)
    const spacyEntry = entryByPath(after, SPACY);
    const spacyReceipt = receiptOf(stateDir, spacyEntry.entryId);
    expect(spacyReceipt.recoveryText).toContain("'");

    // 幂等:二跑全部 already-preserved,不重复存证
    const second = preserveTo(stateDir);
    expect(second.status, second.stdout).toBe(0);
    expect(second.stdout.match(/already-preserved/g)?.length).toBe(reclaims.length);
  });

  it('immutable 归档 ref:同名 ref 已存在 → update-ref expected-old=zero 拒绝覆盖(B0 SC2)', { timeout: 60_000 }, () => {
    const sha = sh(work, GIT_BIN, ['rev-parse', 'HEAD']);
    const other = sh(join(tmp, 'wt-unpushed'), GIT_BIN, ['rev-parse', 'HEAD']);
    sh(work, GIT_BIN, ['update-ref', 'refs/patrol/test-immutable', sha, '0'.repeat(40)]);
    const overwrite = spawnSync(GIT_BIN, ['-C', work, 'update-ref', 'refs/patrol/test-immutable', other, '0'.repeat(40)], { encoding: 'utf8' });
    expect(overwrite.status).not.toBe(0);
    expect(sh(work, GIT_BIN, ['rev-parse', 'refs/patrol/test-immutable'])).toBe(sha);
  });

  it('故障注入:update-ref 失败 → 回滚 + manifest 全等 + 非零退出(B0 SC5)', { timeout: 120_000 }, () => {
    // 独立 fixture worktree:避免污染主场景(它们的 receipt 已写)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-inj1'), '-b', 'f-inj1']);
    writeFileSync(join(tmp, 'wt-inj1', 'i.txt'), 'i\n');
    const pre = computeManifest(join(tmp, 'wt-inj1'));
    const stateDir = join(tmp, 'st-inj1');
    bootstrapTo(stateDir);
    const result = preserveTo(stateDir, { PATROL_FAIL_GIT: 'update-ref' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('preservation_failed');
    // 原工作树回滚后与 pre-state 全等
    const post = computeManifest(join(tmp, 'wt-inj1'));
    expect(manifestEqual(post, pre)).toBe(true);
    expect(post.head).toBe(pre.head);
    // receipt 不得存在(不得 valid)
    const entry = entryByPath(ledgerOf(stateDir).entries, 'wt-inj1');
    expect(existsSync(join(stateDir, 'receipts', `${entry.entryId}.json`))).toBe(false);
    expect(ledgerOf(stateDir).entries[entry.entryId].lifecycle).toBe('preserve-failed');
    sh(work, GIT_BIN, ['worktree', 'remove', '--force', join(tmp, 'wt-inj1')]);
    sh(work, GIT_BIN, ['branch', '-D', 'f-inj1']);
  });

  it('故障注入:stash push 失败 → 原工作树零变化;bundle create 失败 → 零变化(B0 SC5)', { timeout: 120_000 }, () => {
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-inj2'), '-b', 'f-inj2']);
    writeFileSync(join(tmp, 'wt-inj2', 'j.txt'), 'j\n');
    const pre = computeManifest(join(tmp, 'wt-inj2'));
    const stateDir = join(tmp, 'st-inj2');
    bootstrapTo(stateDir);
    const stashFail = preserveTo(stateDir, { PATROL_FAIL_GIT: 'stash push' });
    expect(stashFail.status).not.toBe(0);
    expect(manifestEqual(computeManifest(join(tmp, 'wt-inj2')), pre)).toBe(true);

    // bundle 注入:unpushed 项(重新建账到新 state,保证 lifecycle 干净)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-inj3'), '-b', 'f-inj3']);
    writeFileSync(join(tmp, 'wt-inj3', 'k.txt'), 'k\n');
    sh(join(tmp, 'wt-inj3'), GIT_BIN, ['add', '.']);
    sh(join(tmp, 'wt-inj3'), GIT_BIN, ['commit', '-m', 'unpushed']);
    const pre3 = computeManifest(join(tmp, 'wt-inj3'));
    const stateDir3 = join(tmp, 'st-inj3');
    bootstrapTo(stateDir3);
    const bundleFail = preserveTo(stateDir3, { PATROL_FAIL_GIT: 'bundle create' });
    expect(bundleFail.status).not.toBe(0);
    expect(manifestEqual(computeManifest(join(tmp, 'wt-inj3')), pre3)).toBe(true);
    for (const [wt, br] of [[join(tmp, 'wt-inj2'), 'f-inj2'], [join(tmp, 'wt-inj3'), 'f-inj3']]) {
      sh(work, GIT_BIN, ['worktree', 'remove', '--force', wt]);
      sh(work, GIT_BIN, ['branch', '-D', br]);
    }
  });

  it('residue 超预算 → preservation_failed 且工作树零变化(顺序不变量:residue 先于 stash)', { timeout: 120_000 }, () => {
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-inj4'), '-b', 'f-inj4']);
    writeFileSync(join(tmp, 'wt-inj4', 'big.ign'), 'x'.repeat(4096));
    writeFileSync(join(tmp, 'wt-inj4', 'd.txt'), 'd\n'); // dirty:确保 plan 同时含 residue+stash
    const pre = computeManifest(join(tmp, 'wt-inj4'));
    const stateDir = join(tmp, 'st-inj4');
    const tinyConfig = join(tmp, 'tiny.config.json');
    writeFileSync(tinyConfig, JSON.stringify({ thresholdHours: 48, allowedRoots: [tmp], residueMaxBytes: 100, lsofBin: lsofStub, lsofTimeoutMs: 5000 }));
    let result = runNode(BOOTSTRAP, ['--repo', work, '--config', tinyConfig, '--json'], { WORKTREE_PATROL_STATE_DIR: stateDir });
    expect(result.status).toBe(0);
    result = runNode(PRESERVE, ['preserve', '--repo', work, '--config', tinyConfig, '--op', 'op-tiny'], { WORKTREE_PATROL_STATE_DIR: stateDir });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('residueMaxBytes');
    // stash 未发生:工作树(含 dirty 内容)与 pre-state 全等
    expect(manifestEqual(computeManifest(join(tmp, 'wt-inj4')), pre)).toBe(true);
    sh(work, GIT_BIN, ['worktree', 'remove', '--force', join(tmp, 'wt-inj4')]);
    sh(work, GIT_BIN, ['branch', '-D', 'f-inj4']);
  });

  it('preserve 前守门重验:存证前夜出现哨兵/lock → skip 不动(P0-C SC5 接线)', { timeout: 120_000 }, () => {
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-lateguard'), '-b', 'f-lateguard']);
    writeFileSync(join(tmp, 'wt-lateguard', 'g.txt'), 'g\n');
    const stateDir = join(tmp, 'st-guard');
    bootstrapTo(stateDir); // 建账时无哨兵 → reclaim
    expect(entryByPath(ledgerOf(stateDir).entries, 'wt-lateguard').disposition).toBe('reclaim');
    writeFileSync(join(tmp, 'wt-lateguard', '.worktree-keep'), ''); // 建账后放哨兵
    const pre = computeManifest(join(tmp, 'wt-lateguard'));
    const result = preserveTo(stateDir);
    expect(result.stdout).toMatch(/skipped.*wt-lateguard|wt-lateguard.*skipped/s);
    const post = computeManifest(join(tmp, 'wt-lateguard'));
    // 哨兵文件本身在 manifest 里,比较时 pre 已含它;工作树未被 stash/改动
    expect(manifestEqual(post, pre)).toBe(true);
    const entry = entryByPath(ledgerOf(stateDir).entries, 'wt-lateguard');
    expect(existsSync(join(stateDir, 'receipts', `${entry.entryId}.json`))).toBe(false);
    rmSync(join(tmp, 'wt-lateguard', '.worktree-keep'));
    sh(work, GIT_BIN, ['worktree', 'remove', '--force', join(tmp, 'wt-lateguard')]);
    sh(work, GIT_BIN, ['branch', '-D', 'f-lateguard']);
  });
});
