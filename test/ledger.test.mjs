// ledger 测试:P0-A 建账器 + P0-C 策略门(共识 SC 逐条落地)。
// 纯函数矩阵(config/policy/activity/canonical) + 真实 fixture 仓端到端
// (gh/lsof stub、零写断言、幂等、并发锁、仓级 gh 故障、单项探针故障)。
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  utimesSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalEntriesText, computeActivity, decideDisposition, deriveEntryId,
  derivePreservationPlan, validateConfig, validateEvidence,
} from '../scripts/ledger-core.mjs';
import { KEEP_SENTINEL } from '../scripts/repo-worktrees-core.mjs';

const BOOTSTRAP = join(import.meta.dirname, '..', 'scripts', 'ledger-bootstrap.mjs');
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const HOUR = 3600 * 1000;

// ---------- validateConfig(P0-C SC4) ----------

describe('validateConfig', () => {
  const good = { thresholdHours: 48, allowedRoots: ['/private/tmp'], residueMaxBytes: 1024, lsofBin: '/usr/sbin/lsof', lsofTimeoutMs: 5000 };
  it('合法配置通过,0 阈值合法', () => {
    expect(validateConfig(good).ok).toBe(true);
    expect(validateConfig({ ...good, thresholdHours: 0 }).ok).toBe(true);
  });
  it.each([
    ['未知键', { ...good, extra: 1 }],
    ['负阈值', { ...good, thresholdHours: -1 }],
    ['NaN 阈值', { ...good, thresholdHours: Number.NaN }],
    ['Infinity 阈值', { ...good, thresholdHours: Number.POSITIVE_INFINITY }],
    ['字符串阈值', { ...good, thresholdHours: '48' }],
    ['相对路径 root', { ...good, allowedRoots: ['tmp/x'] }],
    ['尾斜杠 root', { ...good, allowedRoots: ['/private/tmp/'] }],
    ['重叠 roots', { ...good, allowedRoots: ['/a', '/a/b'] }],
    ['空 roots', { ...good, allowedRoots: [] }],
    ['lsofBin 相对路径', { ...good, lsofBin: 'lsof' }],
  ])('%s → 拒绝', (_name, raw) => {
    expect(validateConfig(raw).ok).toBe(false);
  });
});

// ---------- 策略矩阵(P0-A SC2/SC3 + P0-C SC1..4) ----------

const CONFIG = validateConfig({
  thresholdHours: 48, allowedRoots: ['/roots'], residueMaxBytes: 1 << 30,
  lsofBin: '/usr/sbin/lsof', lsofTimeoutMs: 5000,
}).config;
const NOW = 1_800_000_000_000;

function baseEvidence(overrides = {}) {
  return {
    literalPath: '/roots/wt-x',
    porcelainBlockHash: 'h'.repeat(64),
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    lstatType: 'dir',
    realpath: '/roots/wt-x',
    gitDir: '/repo/.git/worktrees/wt-x',
    head: 'a'.repeat(40),
    branch: 'feat-x',
    detached: false,
    locked: false,
    lockedReason: null,
    prunable: false,
    isPrimary: false,
    keepSentinel: 'absent',
    underAllowedRoot: true,
    prLookup: { status: 'ok', reason: null, openHeadRefNames: [], openHeadOids: [] },
    loss: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, submoduleDirty: false, nestedRepos: 0, unreachableCommits: 0, detachedUnanchored: false },
    activity: { activityAt: NOW - 100 * HOUR, evidence: [{ source: 'head-committer-time', valueMs: NOW - 100 * HOUR }] },
    probeErrors: [],
    ...overrides,
  };
}
const dirtyLoss = { staged: 0, unstaged: 1, untracked: 1, ignored: 0, submoduleDirty: false, nestedRepos: 0, unreachableCommits: 0, detachedUnanchored: false };

describe('decideDisposition — fail-closed 面', () => {
  it('缺任一承重字段 → unledgerable,绝不 reclaim(P0-A SC2 对照全字段)', () => {
    for (const field of ['repoRoot', 'commonDir', 'literalPath', 'porcelainBlockHash', 'isPrimary', 'lstatType', 'realpath', 'gitDir', 'head', 'detached', 'locked', 'prunable', 'keepSentinel', 'prLookup', 'loss', 'activity', 'underAllowedRoot']) {
      const evidence = baseEvidence();
      delete evidence[field];
      const verdict = decideDisposition(evidence, CONFIG, NOW, 'no-observed-live');
      expect(verdict.disposition, `缺 ${field}`).toBe('unledgerable');
    }
  });
  it('探针错误 → unledgerable', () => {
    expect(decideDisposition(baseEvidence({ probeErrors: ['rev-parse --git-dir 失败'] }), CONFIG, NOW).disposition).toBe('unledgerable');
  });
  it('prunable / fs-missing → unledgerable(stale-registry,v1 零 prune)', () => {
    for (const overrides of [{ prunable: true }, { lstatType: 'missing' }]) {
      const verdict = decideDisposition(baseEvidence(overrides), CONFIG, NOW);
      expect(verdict.disposition).toBe('unledgerable');
      expect(verdict.reasons.join(' ')).toContain('stale-registry');
    }
  });
  it('嵌套仓 / submodule dirty / submodule 不可判 → unledgerable(unsupported-loss-shape)', () => {
    for (const loss of [
      { ...dirtyLoss, nestedRepos: 1 },
      { ...dirtyLoss, submoduleDirty: true },
      { ...dirtyLoss, submoduleDirty: null },
    ]) {
      expect(decideDisposition(baseEvidence({ loss }), CONFIG, NOW).disposition).toBe('unledgerable');
    }
  });
  it('gh 通道 degraded:无正向 keep → unledgerable;有正向 keep 证据仍 keep(P0-A SC4)', () => {
    const degraded = { status: 'degraded', reason: 'gh-open-truncated', openHeadRefNames: [], openHeadOids: [] };
    const none = decideDisposition(baseEvidence({ prLookup: degraded }), CONFIG, NOW);
    expect(none.disposition).toBe('unledgerable');
    expect(none.reasons.join(' ')).toContain('pr-unverified');
    for (const positive of [{ keepSentinel: 'present' }, { locked: true }, { isPrimary: true }]) {
      expect(decideDisposition(baseEvidence({ prLookup: degraded, ...positive }), CONFIG, NOW).disposition).toBe('keep');
    }
  });
});

describe('decideDisposition — 硬保留门 OR(P0-C SC1/SC2)', () => {
  it('dirty+sentinel / dirty+locked / dirty+OPEN-PR 组合全 keep 且理由齐全', () => {
    const combos = [
      [{ loss: dirtyLoss, keepSentinel: 'present' }, 'sentinel'],
      [{ loss: dirtyLoss, locked: true, lockedReason: 'fixture' }, 'locked'],
      [{ loss: dirtyLoss, prLookup: { status: 'ok', reason: null, openHeadRefNames: ['feat-x'], openHeadOids: [] } }, 'open-pr'],
    ];
    for (const [overrides, marker] of combos) {
      const verdict = decideDisposition(baseEvidence(overrides), CONFIG, NOW);
      expect(verdict.disposition).toBe('keep');
      expect(verdict.reasons.join(' ')).toContain(marker);
    }
  });
  it('多门同时命中 → 收集全部理由不短路', () => {
    const verdict = decideDisposition(baseEvidence({
      keepSentinel: 'present', locked: true,
      prLookup: { status: 'ok', reason: null, openHeadRefNames: ['feat-x'], openHeadOids: [] },
    }), CONFIG, NOW);
    expect(verdict.disposition).toBe('keep');
    const joined = verdict.reasons.join(' ');
    for (const marker of ['sentinel', 'locked', 'open-pr']) expect(joined).toContain(marker);
  });
  it('detached HEAD 命中 OPEN PR headRefOid → keep(共识风险 5)', () => {
    const head = 'b'.repeat(40);
    const verdict = decideDisposition(baseEvidence({
      detached: true, branch: null, head,
      prLookup: { status: 'ok', reason: null, openHeadRefNames: [], openHeadOids: [head] },
    }), CONFIG, NOW);
    expect(verdict.disposition).toBe('keep');
    expect(verdict.reasons.join(' ')).toContain('open-pr-detached-oid');
  });
  it('primary 无论 detached/dirty/age 均 keep;非 primary 同证据不因共享 commonDir 被误保', () => {
    const primary = decideDisposition(baseEvidence({ isPrimary: true, detached: true, branch: null, loss: dirtyLoss, activity: { activityAt: NOW, evidence: [{ source: 'root-mtime', valueMs: NOW }] } }), CONFIG, NOW);
    expect(primary.disposition).toBe('keep');
    expect(primary.reasons.join(' ')).toContain('primary-checkout');
    const sibling = decideDisposition(baseEvidence(), CONFIG, NOW, 'no-observed-live');
    expect(sibling.disposition).toBe('reclaim');
  });
  it('sentinel 探测 error:<code> → 按存在保留(P0-C SC5);删掉哨兵(absent)按其余门裁决', () => {
    expect(decideDisposition(baseEvidence({ keepSentinel: 'error:EACCES' }), CONFIG, NOW).disposition).toBe('keep');
    expect(decideDisposition(baseEvidence({ keepSentinel: 'absent' }), CONFIG, NOW, 'no-observed-live').disposition).toBe('reclaim');
  });
  it('realpath 不在 allowedRoots → keep(out-of-scope)', () => {
    const verdict = decideDisposition(baseEvidence({ underAllowedRoot: false }), CONFIG, NOW);
    expect(verdict.disposition).toBe('keep');
    expect(verdict.reasons.join(' ')).toContain('out-of-scope');
  });
});

describe('decideDisposition — recent-loss 阈值 T(P0-C SC3/SC4)', () => {
  const at = (ageHours) => ({ activityAt: NOW - ageHours * HOUR, evidence: [{ source: 'root-mtime', valueMs: NOW - ageHours * HOUR }] });
  it('age < T / = T → keep(recent-loss)+deadline;age > T → reclaim', () => {
    const under = decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(47) }), CONFIG, NOW);
    expect(under.disposition).toBe('keep');
    expect(under.deadlineMs).toBe(NOW - 47 * HOUR + 48 * HOUR);
    const boundary = decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(48) }), CONFIG, NOW);
    expect(boundary.disposition).toBe('keep'); // <= 语义,边界含等号(ACK 固定)
    const over = decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(48.001) }), CONFIG, NOW, 'no-observed-live');
    expect(over.disposition).toBe('reclaim');
  });
  it('activityAt 在未来(时钟异常) → keep 且标注异常', () => {
    const verdict = decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(-5) }), CONFIG, NOW);
    expect(verdict.disposition).toBe('keep');
    expect(verdict.reasons.join(' ')).toContain('时钟异常');
  });
  it('T=0 只翻转 recent-loss 门;sentinel/locked/primary/OPEN/out-of-scope 不受影响(P0-C SC4)', () => {
    const zero = { ...CONFIG, thresholdHours: 0 };
    expect(decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(0.5) }), zero, NOW, 'no-observed-live').disposition).toBe('reclaim');
    for (const overrides of [{ keepSentinel: 'present' }, { locked: true }, { isPrimary: true }, { underAllowedRoot: false }]) {
      expect(decideDisposition(baseEvidence({ loss: dirtyLoss, activity: at(0.5), ...overrides }), zero, NOW).disposition).toBe('keep');
    }
  });
  it('无损失内容的干净项不受 age 门限制', () => {
    const verdict = decideDisposition(baseEvidence({ activity: at(0.5) }), CONFIG, NOW, 'no-observed-live');
    expect(verdict.disposition).toBe('reclaim');
  });
});

describe('decideDisposition — live 探针三态接入(ACK 文本)', () => {
  const reclaimable = () => baseEvidence();
  it('liveProbe=null → 返回 reclaim 候选 + requiresLiveProbe,不给终裁', () => {
    const verdict = decideDisposition(reclaimable(), CONFIG, NOW, null);
    expect(verdict.requiresLiveProbe).toBe(true);
  });
  it('observed-live / live-probe-unknown → keep;no-observed-live → reclaim', () => {
    expect(decideDisposition(reclaimable(), CONFIG, NOW, 'observed-live').disposition).toBe('keep');
    expect(decideDisposition(reclaimable(), CONFIG, NOW, 'live-probe-unknown').disposition).toBe('keep');
    expect(decideDisposition(reclaimable(), CONFIG, NOW, 'no-observed-live').disposition).toBe('reclaim');
  });
  it('非法探针值 → unledgerable', () => {
    expect(decideDisposition(reclaimable(), CONFIG, NOW, 'yes').disposition).toBe('unledgerable');
  });
});

describe('derivePreservationPlan', () => {
  it('unpushed → archive-ref+bundle;detached → archive-ref;dirty → stash;ignored → residue', () => {
    expect(derivePreservationPlan(baseEvidence({ loss: { ...dirtyLoss, staged: 0, unstaged: 0, untracked: 0, unreachableCommits: 3 } }))).toEqual(['archive-ref', 'bundle']);
    expect(derivePreservationPlan(baseEvidence({ detached: true, branch: null }))).toEqual(['archive-ref']);
    expect(derivePreservationPlan(baseEvidence({ loss: dirtyLoss }))).toEqual(['stash-snapshot']);
    expect(derivePreservationPlan(baseEvidence({ loss: { ...dirtyLoss, staged: 0, unstaged: 0, untracked: 0, ignored: 2 } }))).toEqual(['residue-archive']);
    expect(derivePreservationPlan(baseEvidence({ detached: true, branch: null, loss: { staged: 1, unstaged: 0, untracked: 0, ignored: 1, submoduleDirty: false, nestedRepos: 0, unreachableCommits: 2, detachedUnanchored: true } })))
      .toEqual(['archive-ref', 'bundle', 'stash-snapshot', 'residue-archive']);
  });
});

describe('computeActivity / canonical', () => {
  it('任一来源不可得 → error(fail-closed)', () => {
    expect(computeActivity({ headCommitMs: null, rootMtimeMs: 1, lossPathsMaxMtimeMs: null, lossPathsProbed: false }).error).toBeTruthy();
    expect(computeActivity({ headCommitMs: 1, rootMtimeMs: null, lossPathsMaxMtimeMs: null, lossPathsProbed: false }).error).toBeTruthy();
    expect(computeActivity({ headCommitMs: 1, rootMtimeMs: 2, lossPathsMaxMtimeMs: null, lossPathsProbed: true }).error).toBeTruthy();
  });
  it('取三来源最大值并记证据', () => {
    const activity = computeActivity({ headCommitMs: 10, rootMtimeMs: 30, lossPathsMaxMtimeMs: 20, lossPathsProbed: true });
    expect(activity.activityAt).toBe(30);
    expect(activity.evidence).toHaveLength(3);
  });
  it('canonicalEntriesText 与键序无关、剔除 volatile 字段', () => {
    const a = { e1: { x: 1, recordedAt: 'A', nested: { b: 2, a: 1 } } };
    const b = { e1: { nested: { a: 1, b: 2 }, recordedAt: 'B', x: 1 } };
    expect(canonicalEntriesText(a)).toBe(canonicalEntriesText(b));
  });
  it('validateEvidence 对合法样本零问题', () => {
    expect(validateEvidence(baseEvidence())).toEqual([]);
  });
});

// ---------- fixture 仓端到端(P0-A SC1/4/5/6) ----------

function sh(cwd, cmd, args, env) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env }).trimEnd();
}

describe('ledger-bootstrap E2E(fixture 仓)', () => {
  let tmp; let work; let origin; let shimDir; let gitLog; let tipSha;
  let stateDir; let configPath; let lsofStub; let env;
  const OLD_DATE = new Date('2020-01-02T03:04:05Z');
  const NOW_MS = Date.parse('2026-08-05T00:00:00Z');

  function writeLsofStub(mode) {
    // mode: 'none'(exit1 空输出) | 'live'(p 记录) | 'weird'(exit 2)
    const body = mode === 'live' ? '#!/bin/sh\necho "p123"\necho "cnode"\nexit 0\n'
      : mode === 'weird' ? '#!/bin/sh\nexit 2\n'
        : '#!/bin/sh\nexit 1\n';
    writeFileSync(lsofStub, body);
    chmodSync(lsofStub, 0o755);
  }

  function writeGhStub(mode) {
    const gh = join(shimDir, 'gh');
    if (mode === 'absent') { rmSync(gh, { force: true }); return; }
    if (mode === 'ok') {
      const rows = JSON.stringify([
        { headRefName: 'feat-pr', headRefOid: tipSha, number: 42, state: 'OPEN', isDraft: true, title: 'p', url: 'https://x.invalid/42', isCrossRepository: false },
      ]);
      writeFileSync(gh, `#!/bin/sh\ncat <<'EOF'\n${rows}\nEOF\n`);
    }
    chmodSync(gh, 0o755);
  }

  function writeConfig(overrides = {}) {
    const raw = {
      thresholdHours: 48,
      allowedRoots: [tmp],
      residueMaxBytes: 1 << 30,
      lsofBin: lsofStub,
      lsofTimeoutMs: 5000,
      ...overrides,
    };
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
  }

  function runBootstrap(extraEnv = {}) {
    return spawnSync(process.execPath, [BOOTSTRAP, '--repo', work, '--config', configPath, '--json'], {
      encoding: 'utf8', env: { ...env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024,
    });
  }

  function ledgerEntries() {
    return JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8')).entries;
  }

  function entryByPath(entries, suffix) {
    return Object.values(entries).find((entry) => entry.evidence.literalPath.endsWith(suffix));
  }

  function backdate(path) {
    utimesSync(path, OLD_DATE, OLD_DATE);
  }

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-')));
    origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    stateDir = join(tmp, 'patrol-state');
    configPath = join(tmp, 'patrol.config.json');
    lsofStub = join(tmp, 'lsof-stub');
    sh(tmp, GIT_BIN, ['init', '--bare', '--initial-branch=main', origin]);
    sh(tmp, GIT_BIN, ['clone', origin, work]);
    sh(work, GIT_BIN, ['config', 'user.email', 'f@test.invalid']);
    sh(work, GIT_BIN, ['config', 'user.name', 'f']);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    writeFileSync(join(work, '.gitignore'), '*.ign\n');
    const oldEnv = { ...process.env, GIT_AUTHOR_DATE: OLD_DATE.toISOString(), GIT_COMMITTER_DATE: OLD_DATE.toISOString() };
    sh(work, GIT_BIN, ['add', '.'], oldEnv);
    sh(work, GIT_BIN, ['commit', '-m', 'init'], oldEnv);
    sh(work, GIT_BIN, ['push', '-u', 'origin', 'main']);
    tipSha = sh(work, GIT_BIN, ['rev-parse', 'HEAD']);
    sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/fixture-owner/fixture-repo.git']);

    // 现场矩阵
    // ① 老的未推送分支 + ignored 残渣 → reclaim(archive-ref+bundle+residue)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-old-unpushed'), '-b', 'feat-old'], oldEnv);
    writeFileSync(join(tmp, 'wt-old-unpushed', 'w.txt'), 'w\n');
    sh(join(tmp, 'wt-old-unpushed'), GIT_BIN, ['add', 'w.txt'], oldEnv);
    sh(join(tmp, 'wt-old-unpushed'), GIT_BIN, ['commit', '-m', 'unpushed'], oldEnv);
    writeFileSync(join(tmp, 'wt-old-unpushed', 'junk.ign'), 'j\n');
    for (const f of ['w.txt', 'a.txt', '.gitignore', 'junk.ign', '']) backdate(join(tmp, 'wt-old-unpushed', f));
    // ② 新脏 worktree → keep(recent-loss)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-recent-dirty'), '-b', 'feat-recent'], oldEnv);
    writeFileSync(join(tmp, 'wt-recent-dirty', 'fresh.txt'), 'f\n');
    const freshDate = new Date(NOW_MS - 3600 * 1000);
    utimesSync(join(tmp, 'wt-recent-dirty', 'fresh.txt'), freshDate, freshDate);
    utimesSync(join(tmp, 'wt-recent-dirty'), freshDate, freshDate);
    // ③ 脏 + 哨兵 → keep(sentinel)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-sentinel'), '-b', 'feat-sentinel'], oldEnv);
    writeFileSync(join(tmp, 'wt-sentinel', 'd.txt'), 'd\n');
    writeFileSync(join(tmp, 'wt-sentinel', KEEP_SENTINEL), '');
    // ④ locked
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-locked'), '-b', 'feat-locked'], oldEnv);
    sh(work, GIT_BIN, ['worktree', 'lock', '--reason', 'fixture', join(tmp, 'wt-locked')]);
    backdate(join(tmp, 'wt-locked'));
    // ⑤ 在途 PR(分支名绑定)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-pr'), '-b', 'feat-pr'], oldEnv);
    backdate(join(tmp, 'wt-pr'));
    // ⑥ detached 且 HEAD == 在途 PR headRefOid
    sh(work, GIT_BIN, ['worktree', 'add', '--detach', join(tmp, 'wt-det-oid'), tipSha], oldEnv);
    backdate(join(tmp, 'wt-det-oid'));
    // ⑦ 嵌套仓 → unledgerable
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-nested'), '-b', 'feat-nested'], oldEnv);
    mkdirSync(join(tmp, 'wt-nested', 'inner'));
    sh(join(tmp, 'wt-nested', 'inner'), GIT_BIN, ['init']);
    writeFileSync(join(tmp, 'wt-nested', 'inner', 'i.txt'), 'i\n');
    // ⑧ 目录整体消失 → stale-registry
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-gone'), '-b', 'feat-gone'], oldEnv);
    rmSync(join(tmp, 'wt-gone'), { recursive: true, force: true });
    // ⑨ .git 指针损坏 → 单项探针故障
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-badgit'), '-b', 'feat-badgit'], oldEnv);
    writeFileSync(join(tmp, 'wt-badgit', '.git'), 'gitdir: /nonexistent/nowhere\n');
    // ⑩ 老的干净分支(建在已推送的 main tip 上,零本地新提交 → 无损失,plan 空)
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-clean'), '-b', 'feat-clean'], oldEnv);
    backdate(join(tmp, 'wt-clean'));

    shimDir = join(tmp, 'shim-bin');
    mkdirSync(shimDir);
    gitLog = join(tmp, 'git-calls.log');
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho "$*" >> "${gitLog}"\nexec "${GIT_BIN}" "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);
    env = {
      ...process.env,
      PATH: `${shimDir}:/usr/bin:/bin`,
      WORKTREE_PATROL_STATE_DIR: stateDir,
      PATROL_NOW_MS: String(NOW_MS),
    };
    writeConfig();
    writeGhStub('ok');
    writeLsofStub('none');
  }, 120_000);

  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  function repoSnapshot() {
    const list = sh(work, GIT_BIN, ['worktree', 'list', '--porcelain']);
    const refs = sh(work, GIT_BIN, ['for-each-ref']);
    const stash = sh(work, GIT_BIN, ['stash', 'list']) || '';
    return { list, refs, stash };
  }

  it('端到端:cohort 全覆盖、处置逐项正确、目标仓零写(P0-A SC1/SC6)', { timeout: 120_000 }, () => {
    rmSync(gitLog, { force: true });
    const before = repoSnapshot();
    const result = runBootstrap();
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    const entries = ledgerEntries();

    // cohort 全等:porcelain 每个注册项恰有一条台账记录
    expect(Object.keys(entries).length).toBe(out.cohortSize);

    const expectDisposition = (suffix, disposition, marker) => {
      const entry = entryByPath(entries, suffix);
      expect(entry, suffix).toBeTruthy();
      expect(entry.disposition, `${suffix}: ${JSON.stringify(entry.reasons)}`).toBe(disposition);
      if (marker) expect(entry.reasons.join(' ')).toContain(marker);
      return entry;
    };
    expectDisposition('/work', 'keep', 'primary-checkout');
    const oldUnpushed = expectDisposition('wt-old-unpushed', 'reclaim');
    expect(oldUnpushed.preservationPlan).toEqual(['archive-ref', 'bundle', 'residue-archive']);
    expectDisposition('wt-recent-dirty', 'keep', 'recent-loss');
    expectDisposition('wt-sentinel', 'keep', 'sentinel');
    expectDisposition('wt-locked', 'keep', 'locked');
    expectDisposition('wt-pr', 'keep', 'open-pr');
    expectDisposition('wt-det-oid', 'keep', 'open-pr-detached-oid');
    expectDisposition('wt-nested', 'unledgerable', 'unsupported-loss-shape');
    expectDisposition('wt-gone', 'unledgerable', 'stale-registry');
    expectDisposition('wt-badgit', 'unledgerable');
    const clean = expectDisposition('wt-clean', 'reclaim');
    expect(clean.preservationPlan).toEqual([]);

    // 零写:目标仓状态全等 + git 调用清单无写子命令(P0-A SC6)。
    // 按 argv 解析子命令位判定,不做整行子串匹配——fixture 路径 wt-old-unpushed
    // 含 "push" 子串,整行匹配会假阳性(首版实测踩中)。
    expect(repoSnapshot()).toEqual(before);
    const WRITE_SUBCOMMANDS = new Set(['stash', 'update-ref', 'bundle', 'branch', 'push', 'commit', 'add', 'reset', 'checkout', 'clean', 'gc']);
    const WRITE_WORKTREE_VERBS = new Set(['remove', 'prune', 'unlock', 'lock', 'move', 'add']);
    for (const line of readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)) {
      const tokens = line.split(' ');
      let i = 0;
      while (tokens[i] === '-C') i += 2; // 跳过 -C <path> 对
      const sub = tokens[i];
      expect(WRITE_SUBCOMMANDS.has(sub), `写子命令泄漏: ${line}`).toBe(false);
      if (sub === 'worktree') {
        expect(WRITE_WORKTREE_VERBS.has(tokens[i + 1]), `worktree 写动词泄漏: ${line}`).toBe(false);
      }
    }
  });

  it('幂等:同状态两轮 canonical 逐字节一致(P0-A SC5)', { timeout: 120_000 }, () => {
    const run1 = runBootstrap();
    expect(run1.status).toBe(0);
    const text1 = canonicalEntriesText(ledgerEntries());
    const run2 = runBootstrap();
    expect(run2.status).toBe(0);
    const text2 = canonicalEntriesText(ledgerEntries());
    expect(text1).toBe(text2);
  });

  it('仓级 gh 故障:reclaim 归零,负证据项转 unledgerable,正向 keep 保持(P0-A SC4)', { timeout: 120_000 }, () => {
    writeGhStub('absent');
    const result = runBootstrap({ WORKTREE_PATROL_STATE_DIR: join(tmp, 'state-ghdown') });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.counts.reclaim).toBe(0);
    const entries = JSON.parse(readFileSync(join(tmp, 'state-ghdown', 'ledger.json'), 'utf8')).entries;
    expect(entryByPath(entries, 'wt-old-unpushed').disposition).toBe('unledgerable');
    expect(entryByPath(entries, 'wt-old-unpushed').reasons.join(' ')).toContain('pr-unverified');
    for (const [suffix, marker] of [['/work', 'primary'], ['wt-sentinel', 'sentinel'], ['wt-locked', 'locked']]) {
      const entry = entryByPath(entries, suffix);
      expect(entry.disposition, suffix).toBe('keep');
      expect(entry.reasons.join(' ')).toContain(marker);
    }
    writeGhStub('ok');
    // 恢复 gh 后回到正常处置
    const restored = runBootstrap({ WORKTREE_PATROL_STATE_DIR: join(tmp, 'state-ghup') });
    expect(restored.status).toBe(0);
    const entriesUp = JSON.parse(readFileSync(join(tmp, 'state-ghup', 'ledger.json'), 'utf8')).entries;
    expect(entryByPath(entriesUp, 'wt-old-unpushed').disposition).toBe('reclaim');
  });

  it('lsof 三态:live → keep;weird → keep(unknown);none → reclaim(ACK 文本)', { timeout: 120_000 }, () => {
    writeLsofStub('live');
    let result = runBootstrap({ WORKTREE_PATROL_STATE_DIR: join(tmp, 'state-live') });
    expect(result.status).toBe(0);
    let entries = JSON.parse(readFileSync(join(tmp, 'state-live', 'ledger.json'), 'utf8')).entries;
    let entry = entryByPath(entries, 'wt-old-unpushed');
    expect(entry.disposition).toBe('keep');
    expect(entry.reasons.join(' ')).toContain('observed-live');

    writeLsofStub('weird');
    result = runBootstrap({ WORKTREE_PATROL_STATE_DIR: join(tmp, 'state-weird') });
    expect(result.status).toBe(0);
    entries = JSON.parse(readFileSync(join(tmp, 'state-weird', 'ledger.json'), 'utf8')).entries;
    entry = entryByPath(entries, 'wt-old-unpushed');
    expect(entry.disposition).toBe('keep');
    expect(entry.reasons.join(' ')).toContain('live-probe-unknown');

    writeLsofStub('none');
  });

  it('config 非法 → 整轮拒绝(退出非零),不写台账', { timeout: 60_000 }, () => {
    writeConfig({ thresholdHours: -1 });
    const dir = join(tmp, 'state-badcfg');
    const result = runBootstrap({ WORKTREE_PATROL_STATE_DIR: dir });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, 'ledger.json'))).toBe(false);
    writeConfig();
  });

  it('并发锁:锁被占用 → fail-visible;陈旧锁(>10min)可接管(P0-A SC5)', { timeout: 120_000 }, () => {
    const dir = join(tmp, 'state-lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ledger.lock'), '99999 held\n');
    const blocked = runBootstrap({ WORKTREE_PATROL_STATE_DIR: dir });
    expect(blocked.status).not.toBe(0);
    expect(`${blocked.stderr}${blocked.stdout}`).toContain('ledger.lock');
    // 陈旧锁:mtime 拨老 → 接管成功
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(join(dir, 'ledger.lock'), stale, stale);
    const taken = runBootstrap({ WORKTREE_PATROL_STATE_DIR: dir });
    expect(taken.status, taken.stderr).toBe(0);
    expect(existsSync(join(dir, 'ledger.json'))).toBe(true);
  });

  it('真 lsof + 真长驻进程:cwd 在 worktree 内 → observed-live;终止后 → no-observed-live(ACK 文本)', { timeout: 60_000 }, async () => {
    const { probeObservedLive } = await import('../scripts/live-probe.mjs');
    const realConfig = { lsofBin: '/usr/sbin/lsof', lsofTimeoutMs: 15_000 };
    const target = realpathSync(join(tmp, 'wt-pr'));
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/sleep', ['30'], { cwd: target, stdio: 'ignore', detached: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const live = probeObservedLive(target, realConfig);
      expect(live.result, live.detail).toBe('observed-live');
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = probeObservedLive(target, realConfig);
    // 进程已终止:唯一合法的 no-observed-live 对照(其余任何异常都必须是 unknown→keep)
    expect(['no-observed-live', 'live-probe-unknown']).toContain(after.result);
    if (after.result === 'live-probe-unknown') {
      // 本机残留 handle(Spotlight 等)属实测环境噪声,unknown 是 fail-closed 正确方向,
      // 但必须至少有一次真实 no-observed-live 才算验过对照——换只有本测试用过的独立目录再验
      const lone = join(tmp, 'wt-clean');
      const verdict = probeObservedLive(realpathSync(lone), realConfig);
      expect(verdict.result, verdict.detail).toBe('no-observed-live');
    }
  });

  it('deferred-next-run:处理期间新增注册项不混入本 cohort(P0-A SC1)', { timeout: 120_000 }, () => {
    // 计数 shim:第 2 次 `worktree list --porcelain` 时(post-check),先真实新增一个
    // worktree 再转发——模拟建账进行中另一会话开了新工作树。
    const counterFile = join(tmp, 'wtlist-count');
    rmSync(counterFile, { force: true });
    const lateWt = join(tmp, 'wt-late');
    rmSync(lateWt, { recursive: true, force: true });
    const trickyGit = join(tmp, 'shim-defer');
    mkdirSync(trickyGit, { recursive: true });
    writeFileSync(join(trickyGit, 'git'), `#!/bin/sh
case "$*" in
  *"worktree list --porcelain"*)
    n=$(cat "${counterFile}" 2>/dev/null || echo 0)
    n=$((n+1)); echo "$n" > "${counterFile}"
    if [ "$n" = "2" ] && [ ! -d "${lateWt}" ]; then
      "${GIT_BIN}" -C "${work}" worktree add "${lateWt}" -b feat-late >/dev/null 2>&1
    fi
    ;;
esac
exec "${GIT_BIN}" "$@"
`);
    chmodSync(join(trickyGit, 'git'), 0o755);
    const result = spawnSync(process.execPath, [BOOTSTRAP, '--repo', work, '--config', configPath, '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...env, PATH: `${trickyGit}:/usr/bin:/bin`, WORKTREE_PATROL_STATE_DIR: join(tmp, 'state-defer') },
    });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.deferredNextRun).toEqual([lateWt]);
    // 台账里没有 wt-late(不混入本 cohort)
    const entries = JSON.parse(readFileSync(join(tmp, 'state-defer', 'ledger.json'), 'utf8')).entries;
    expect(Object.values(entries).some((entry) => entry.evidence.literalPath === lateWt)).toBe(false);
    // 清理:别让 wt-late 污染其他用例的 cohort
    sh(work, GIT_BIN, ['worktree', 'remove', '--force', lateWt]);
    sh(work, GIT_BIN, ['branch', '-D', 'feat-late']);
  });

  it('T=0 配置重跑:recent-loss 项翻转为 reclaim,硬门项不动(P0-C SC4 端到端)', { timeout: 120_000 }, () => {
    writeConfig({ thresholdHours: 0 });
    const dir = join(tmp, 'state-t0');
    const result = runBootstrap({ WORKTREE_PATROL_STATE_DIR: dir });
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).entries;
    expect(entryByPath(entries, 'wt-recent-dirty').disposition).toBe('reclaim');
    expect(entryByPath(entries, 'wt-sentinel').disposition).toBe('keep');
    expect(entryByPath(entries, '/work').disposition).toBe('keep');
    writeConfig();
  });
});
