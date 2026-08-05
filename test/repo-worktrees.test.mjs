// repo-worktrees 测试:纯判定核心(classify/parse)+ CLI 集成(真实 fixture 仓)。
// 集成测试用 PATH shim 包一层 git/gh:git shim 记录全部调用供零写断言,gh stub
// 按场景返回预置 JSON / 垃圾 / 睡死,覆盖 degraded 三态。
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLASSIFICATION_RANK, classify, parsePorcelainWorktrees, KEEP_SENTINEL } from '../scripts/repo-worktrees-core.mjs';
import { parseRepoSlug } from '../scripts/repo-worktrees.mjs';

const CLI = join(import.meta.dirname, '..', 'scripts', 'repo-worktrees.mjs');

// ---------- 纯函数:porcelain 解析 ----------

describe('parsePorcelainWorktrees', () => {
  it('解析 branch/detached/locked/prunable 标记', () => {
    const text = [
      'worktree /a',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /b',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      '',
      'worktree /c',
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/feat-x',
      'locked 手动锁定',
      '',
      'worktree /d',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/feat-y',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const items = parsePorcelainWorktrees(text);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ path: '/a', branchRef: 'refs/heads/main', detached: false, locked: false });
    expect(items[1]).toMatchObject({ path: '/b', detached: true });
    expect(items[2]).toMatchObject({ locked: true, lockedReason: '手动锁定' });
    expect(items[3]).toMatchObject({ prunable: true });
    expect(items[3].prunableReason).toContain('non-existent');
  });
});

// ---------- 纯函数:分类 ----------

function baseRow(overrides = {}) {
  return {
    prunable: false,
    missing: false,
    probeErrors: [],
    locked: false,
    lockedReason: null,
    detached: false,
    dirty: 0,
    inBase: false,
    hasKeep: false,
    branch: 'feat-x',
    upstream: 'origin/feat-x',
    aheadOfUpstream: 0,
    ahead: 0,
    pr: null,
    prLookupOk: true,
    ...overrides,
  };
}

describe('classify', () => {
  const cases = [
    ['prunable 最优先', { prunable: true, missing: true }, 'prunable (path gone)', false],
    ['目录丢失且未标 prunable → missing fail-closed', { missing: true }, 'missing (unknown state)', false],
    ['探针失败 → unknown fail-closed', { probeErrors: ['git status 失败'] }, 'unknown (probe failed)', false],
    ['locked', { locked: true }, 'locked', false],
    ['detached + dirty 最危险', { detached: true, branch: 'DETACHED', dirty: 2 }, 'detached dirty danger', false],
    ['已合入但 dirty', { dirty: 1, inBase: true }, 'HEAD merged, worktree dirty', false],
    ['dirty WIP', { dirty: 3 }, 'dirty WIP', false],
    ['active PR 优先于 inBase removable', { inBase: true, pr: { number: 7, state: 'OPEN', isDraft: true } }, 'active PR', false],
    ['keep 哨兵不 removable', { inBase: true, hasKeep: true }, 'keep sentinel', false],
    ['detached clean', { detached: true, branch: 'DETACHED' }, 'detached clean', false],
    ['main 领先 upstream = 未推送', { branch: 'main', aheadOfUpstream: 2 }, 'local unpushed feature', false],
    ['main clean(inBase 且零领先)', { branch: 'main', inBase: true }, 'main clean', false],
    ['main 无 upstream 且领先 base → 不得报 main clean(R2 CV2-R2-003)', { branch: 'main', upstream: 'none', aheadOfUpstream: null, inBase: false, ahead: 1 }, 'local unpushed feature', false],
    ['inBase + 探针完整 + 无关联 PR → removable(唯一 true)', { inBase: true, upstream: 'none' }, 'clean merged removable', true],
    ['inBase 但 PR 查询 degraded → fail-closed', { inBase: true, prLookupOk: false }, 'clean merged (unverified PR)', false],
    ['inBase + 关联 PR 但 boundToHead=false → 不 removable(R1 CLA-R1-02)', { inBase: true, upstream: 'none', pr: { number: 999, state: 'MERGED', boundToHead: false } }, 'clean merged (PR head 未绑定)', false],
    ['inBase + 关联 PR 且 boundToHead=true → removable', { inBase: true, upstream: 'none', pr: { number: 7, state: 'MERGED', boundToHead: true } }, 'clean merged removable', true],
    ['squash 合并后:PR merged 但 HEAD 不在基线', { pr: { number: 9, state: 'MERGED' }, upstream: 'none' }, 'PR merged', false],
    ['无 upstream 未合入 → unpushed', { upstream: 'none' }, 'local unpushed feature', false],
    ['领先 upstream 未合入 → unpushed', { aheadOfUpstream: 1 }, 'local unpushed feature', false],
    ['干净分支', {}, 'clean branch', false],
  ];
  it.each(cases)('%s', (_name, overrides, classification, removable) => {
    const verdict = classify(baseRow(overrides));
    expect(verdict.classification).toBe(classification);
    expect(verdict.removable).toBe(removable);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('removable=true 有且只有一条路径(全 fixture 扫描)', () => {
    for (const [, overrides] of cases) {
      const verdict = classify(baseRow(overrides));
      if (verdict.removable) expect(verdict.classification).toBe('clean merged removable');
    }
  });

  // R2 CLA-R2-06:漏传承重字段曾能得出 removable=true(fail-open)
  it('缺承重字段 → input incomplete fail-closed,绝不 removable', () => {
    for (const field of ['dirty', 'inBase', 'prLookupOk', 'hasKeep', 'locked', 'detached', 'prunable', 'missing', 'probeErrors']) {
      const row = baseRow({ inBase: true, upstream: 'none' });
      delete row[field];
      const verdict = classify(row);
      expect(verdict.classification, `缺 ${field} 应 fail-closed`).toBe('input incomplete (fail-closed)');
      expect(verdict.removable).toBe(false);
      expect(verdict.reasons.join(' ')).toContain(field);
    }
  });

  it('dirty/inBase 为 null 却无 prunable/missing/探针失败解释 → 输入不自洽 fail-closed', () => {
    expect(classify(baseRow({ dirty: null })).classification).toBe('input incomplete (fail-closed)');
    expect(classify(baseRow({ inBase: null })).classification).toBe('input incomplete (fail-closed)');
    // 有解释时不误判:prunable/missing 行的 null 是合法的
    expect(classify(baseRow({ dirty: null, inBase: null, prunable: true })).classification).toBe('prunable (path gone)');
    expect(classify(baseRow({ dirty: null, inBase: null, missing: true })).classification).toBe('missing (unknown state)');
  });

  // R2 CLA-R2-02:degraded 时每个出口都必须带 PR 通道未知的告知
  it('prLookupOk=false 时所有出口的 reasons 都带 PR 通道 caveat', () => {
    const exits = [
      { inBase: false, upstream: 'origin/x' },              // clean branch
      { dirty: 2 },                                          // dirty WIP
      { detached: true, branch: 'DETACHED' },                // detached clean
      { upstream: 'none' },                                  // local unpushed
      { branch: 'main', inBase: true },                      // main clean
      { locked: true },                                      // locked
      { inBase: true },                                      // clean merged (unverified PR)
    ];
    for (const overrides of exits) {
      const verdict = classify(baseRow({ ...overrides, prLookupOk: false }));
      expect(verdict.reasons.join(' '), JSON.stringify(overrides)).toContain('PR 查询通道不完整');
      expect(verdict.removable).toBe(false);
    }
    // 通道完整时不出现该 caveat,且 clean branch 才敢说「确认无关联 PR」
    const ok = classify(baseRow({ inBase: false, upstream: 'origin/x', prLookupOk: true }));
    expect(ok.reasons.join(' ')).not.toContain('PR 查询通道不完整');
    expect(ok.reasons.join(' ')).toContain('确认无关联 PR');
  });

  it('全部固定分类都登记 CLASSIFICATION_RANK(R2 U-493-07)', () => {
    const produced = new Set();
    for (const [, overrides] of cases) produced.add(classify(baseRow(overrides)).classification);
    for (const cls of produced) {
      if (/^PR /.test(cls)) continue; // 动态族按设计走 DEFAULT_RANK
      expect(CLASSIFICATION_RANK[cls], `${cls} 未登记 RANK`).toBeTypeOf('number');
    }
    // 两个同族 fail-closed 的 clean-merged 变体必须相邻
    expect(Math.abs(CLASSIFICATION_RANK['clean merged (unverified PR)'] - CLASSIFICATION_RANK['clean merged (PR head 未绑定)'])).toBe(1);
  });
});

// ---------- CLI 集成:真实 fixture 仓 ----------

const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function sh(cwd, cmd, args, env) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env }).trimEnd();
}

function runCli(cwd, args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env });
}

describe('repo-worktrees CLI(fixture 仓)', () => {
  let tmp;
  let work;
  let shimDir;
  let gitLog;
  let tipSha;
  let cliEnv;

  function writeGhStub(mode) {
    // mode: 'ok' | 'garbage' | 'sleep' | 'absent' | 'truncated' | 'badrow'
    const gh = join(shimDir, 'gh');
    if (mode === 'absent') {
      rmSync(gh, { force: true });
      return;
    }
    let body;
    if (mode === 'garbage') {
      body = '#!/bin/sh\necho "not json at all"\n';
    } else if (mode === 'sleep') {
      body = '#!/bin/sh\nsleep 3\necho "[]"\n';
    } else if (mode === 'truncated-open') {
      // 两次查询都返回 200 条 → open 侧截断 → 全局 degraded
      const rows = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
        headRefName: `feat-${i}`, headRefOid: tipSha, number: i + 1, state: 'OPEN',
        isDraft: false, title: 't', url: 'https://example.invalid/', isCrossRepository: false,
      })));
      body = `#!/bin/sh\ncat <<'EOF'\n${rows}\nEOF\n`;
    } else if (mode === 'truncated-history') {
      // open 只 1 条(未截断),all 满 200 条(截断)——按 --state 参数分流应答,
      // 这是本仓真实稳态形状
      const openRows = JSON.stringify([{
        headRefName: 'feat-pr', headRefOid: tipSha, number: 42, state: 'OPEN',
        isDraft: true, title: 'fixture pr', url: 'https://example.invalid/pr/42', isCrossRepository: false,
      }]);
      const allRows = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
        headRefName: `hist-${i}`, headRefOid: tipSha, number: 1000 + i, state: 'MERGED',
        isDraft: false, title: 'h', url: 'https://example.invalid/', isCrossRepository: false,
      })));
      body = `#!/bin/sh\nif echo "$@" | grep -q 'state all'; then\ncat <<'EOF'\n${allRows}\nEOF\nelse\ncat <<'EOF'\n${openRows}\nEOF\nfi\n`;
    } else if (mode === 'badrow') {
      // 一条缺 state 字段的行:字段不可信 → 整批 degraded
      const rows = JSON.stringify([{ headRefName: 'feat-pr', headRefOid: tipSha, number: 42, isDraft: false, isCrossRepository: false }]);
      body = `#!/bin/sh\ncat <<'EOF'\n${rows}\nEOF\n`;
    } else {
      // open/all 均返回同一条 feat-pr 的 OPEN draft PR,headRefOid 绑定真实 tip。
      const rows = JSON.stringify([
        {
          headRefName: 'feat-pr',
          headRefOid: tipSha,
          number: 42,
          state: 'OPEN',
          isDraft: true,
          title: 'fixture pr',
          url: 'https://example.invalid/pr/42',
          isCrossRepository: false,
        },
        {
          headRefName: 'feat-pr',
          headRefOid: tipSha,
          number: 41,
          state: 'CLOSED',
          isDraft: false,
          title: 'old same-name pr',
          url: 'https://example.invalid/pr/41',
          isCrossRepository: false,
        },
        {
          headRefName: 'feat-merged',
          headRefOid: tipSha,
          number: 40,
          state: 'OPEN',
          isDraft: false,
          title: 'cross repo,must be ignored',
          url: 'https://example.invalid/pr/40',
          isCrossRepository: true,
        },
      ]);
      body = `#!/bin/sh\ncat <<'EOF'\n${rows}\nEOF\n`;
    }
    writeFileSync(gh, body);
    chmodSync(gh, 0o755);
  }

  beforeAll(() => {
    // macOS 的 tmpdir 是 /var → /private/var 的符号链接;git 输出规范化路径,
    // 这里必须先 realpath 否则所有 path 比对失配。
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'repo-worktrees-')));
    const origin = join(tmp, 'origin.git');
    work = join(tmp, 'work');
    sh(tmp, GIT_BIN, ['init', '--bare', '--initial-branch=main', origin]);
    sh(tmp, GIT_BIN, ['clone', origin, work]);
    sh(work, GIT_BIN, ['config', 'user.email', 'fixture@test.invalid']);
    sh(work, GIT_BIN, ['config', 'user.name', 'fixture']);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    sh(work, GIT_BIN, ['add', '.']);
    sh(work, GIT_BIN, ['commit', '-m', 'init']);
    sh(work, GIT_BIN, ['push', '-u', 'origin', 'main']);
    tipSha = sh(work, GIT_BIN, ['rev-parse', 'HEAD']);
    // push 完成后把 origin 换成 github URL:PR 查询要求能解出 owner/repo,
    // 本地 bare 路径解不出会走 repo-slug-unresolved 短路(见 gh --repo 用例)。
    // 已建立的 refs/remotes/origin/* 与 @{u} 是 ref 级的,不受 URL 变更影响。
    sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/fixture-owner/fixture-repo.git']);

    // 各分类的 worktree 现场
    // wt-dirty:先做一个本地提交让 HEAD 脱离基线(否则 dirty+inBase 会正确落进
    // "HEAD merged, worktree dirty"),再留一个未跟踪文件 → dirty WIP。
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-dirty'), '-b', 'feat-dirty']);
    writeFileSync(join(tmp, 'wt-dirty', 'committed.txt'), 'c\n');
    sh(join(tmp, 'wt-dirty'), GIT_BIN, ['add', '.']);
    sh(join(tmp, 'wt-dirty'), GIT_BIN, ['commit', '-m', 'wip']);
    writeFileSync(join(tmp, 'wt-dirty', 'x.txt'), 'x\n');
    sh(work, GIT_BIN, ['worktree', 'add', '--detach', join(tmp, 'wt-det-clean')]);
    sh(work, GIT_BIN, ['worktree', 'add', '--detach', join(tmp, 'wt-det-dirty')]);
    writeFileSync(join(tmp, 'wt-det-dirty', 'y.txt'), 'y\n');
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-merged'), '-b', 'feat-merged']);
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-pr'), '-b', 'feat-pr']);
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-keep'), '-b', 'feat-keep']);
    writeFileSync(join(tmp, 'wt-keep', KEEP_SENTINEL), '');
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-unpushed'), '-b', 'feat-unpushed']);
    writeFileSync(join(tmp, 'wt-unpushed', 'z.txt'), 'z\n');
    sh(join(tmp, 'wt-unpushed'), GIT_BIN, ['add', '.']);
    sh(join(tmp, 'wt-unpushed'), GIT_BIN, ['commit', '-m', 'unpushed work']);
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-locked'), '-b', 'feat-locked']);
    sh(work, GIT_BIN, ['worktree', 'lock', '--reason', 'fixture lock', join(tmp, 'wt-locked')]);
    sh(work, GIT_BIN, ['worktree', 'add', join(tmp, 'wt-gone'), '-b', 'feat-gone']);
    rmSync(join(tmp, 'wt-gone'), { recursive: true, force: true });

    // PATH shim:git 记录调用后转发真实 git;gh 按场景写入。
    shimDir = join(tmp, 'shim-bin');
    mkdirSync(shimDir);
    gitLog = join(tmp, 'git-calls.log');
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\necho "OPTLOCKS=\${GIT_OPTIONAL_LOCKS:-unset} $*" >> "${gitLog}"\nexec "${GIT_BIN}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    cliEnv = { ...process.env, PATH: `${shimDir}:/usr/bin:/bin` };
  }, 120_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function snapshotState() {
    const list = sh(work, GIT_BIN, ['worktree', 'list', '--porcelain']);
    const statuses = parsePorcelainWorktrees(list)
      .filter((entry) => !entry.prunable)
      .map((entry) => `${entry.path}::${sh(entry.path, GIT_BIN, ['status', '--porcelain=v1'])}`);
    return { list, statuses };
  }

  it('端到端:--json 纯净、集合全等、分类正确、零写、GIT_OPTIONAL_LOCKS=0', { timeout: 120_000 }, () => {
    writeGhStub('ok');
    rmSync(gitLog, { force: true });
    const before = snapshotState();

    const result = runCli(work, ['--json'], cliEnv);
    expect(result.status).toBe(0);
    // SC-T1b-1: stdout 只含 JSON
    const report = JSON.parse(result.stdout);
    expect(report.prLookup).toEqual({ status: 'ok', reason: null, historyTruncated: false });
    expect(report.repoSlug).toBe('fixture-owner/fixture-repo');
    expect(report.baseLookup.status).toBe('ok');
    expect(report.host).toBeTruthy();
    expect(report.commonDir).toBe(join(work, '.git'));

    // SC-T1b-2: rows 与 porcelain 的 path+HEAD+locked+prunable 集合全等
    const porcelain = parsePorcelainWorktrees(sh(work, GIT_BIN, ['worktree', 'list', '--porcelain']));
    const expectSet = new Set(porcelain.map((e) => `${e.path}|${e.head}|${e.locked}|${e.prunable}`));
    const actualSet = new Set(report.rows.map((r) => `${r.path}|${r.head}|${r.locked}|${r.prunable}`));
    expect(actualSet).toEqual(expectSet);

    // SC-T1a-1/2/4: 逐 worktree 分类断言
    const byPath = new Map(report.rows.map((r) => [r.path, r]));
    const cls = (name) => byPath.get(join(tmp, name))?.classification;
    expect(byPath.get(work).classification).toBe('main clean');
    expect(cls('wt-dirty')).toBe('dirty WIP');
    expect(cls('wt-det-clean')).toBe('detached clean');
    expect(cls('wt-det-dirty')).toBe('detached dirty danger');
    expect(cls('wt-merged')).toBe('clean merged removable');
    expect(byPath.get(join(tmp, 'wt-merged')).removable).toBe(true);
    // active PR 优先于 inBase(feat-pr 的 HEAD 同样在基线)
    const prRow = byPath.get(join(tmp, 'wt-pr'));
    expect(prRow.classification).toBe('active PR');
    expect(prRow.removable).toBe(false);
    expect(prRow.pr).toMatchObject({ number: 42, state: 'OPEN', isDraft: true, boundToHead: true });
    expect(cls('wt-keep')).toBe('keep sentinel');
    expect(byPath.get(join(tmp, 'wt-keep')).hasKeep).toBe(true);
    expect(cls('wt-unpushed')).toBe('local unpushed feature');
    expect(cls('wt-locked')).toBe('locked');
    expect(cls('wt-gone')).toBe('prunable (path gone)');
    // 除 prunable/missing 外全部探针完整
    for (const row of report.rows) {
      if (!row.prunable && !row.missing) expect(row.complete).toBe(true);
      expect(Array.isArray(row.probeErrors)).toBe(true);
      if (row.removable) expect(row.classification).toBe('clean merged removable');
    }

    // SC-T1b-4a: git 调用清单只含只读子命令,且全部带 GIT_OPTIONAL_LOCKS=0
    const calls = sh(tmp, 'cat', [gitLog]).split('\n').filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    // 白名单必须与 mjs 文件头注释的清单一致(R1 U-493-03:两处曾双向漂移)
    const READONLY = new Set(['rev-parse', 'worktree', 'status', 'rev-list', 'merge-base', 'log', 'remote']);
    for (const line of calls) {
      expect(line.startsWith('OPTLOCKS=0 ')).toBe(true);
      const tokens = line.replace('OPTLOCKS=0 ', '').split(/\s+/);
      let sub = null;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '-C') { i++; continue; }
        if (tokens[i].startsWith('-')) continue;
        sub = tokens[i];
        if (sub === 'worktree') expect(tokens[i + 1]).toBe('list');
        break;
      }
      expect(READONLY.has(sub), `非只读 git 子命令: ${line}`).toBe(true);
    }

    // SC-T1b-4b: 运行前后仓库状态全等
    expect(snapshotState()).toEqual(before);
  });

  it('gh 不存在 → prLookup degraded(gh-unavailable),merged 行 fail-closed', { timeout: 60_000 }, () => {
    writeGhStub('absent');
    // hermetic:PATH 只留 shim 目录——带上 /usr/bin:/bin 时 GitHub runner 自带的
    // gh 会顶进来,把 gh-unavailable 变成 gh-error(R1 验收在 CI 上实测)。
    // git 走 shim(内部 exec 绝对路径真 git),shebang /bin/sh 是绝对路径,均不依赖 PATH。
    const result = runCli(work, ['--json'], { ...process.env, PATH: shimDir });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.prLookup.status).toBe('degraded');
    expect(report.prLookup.reason).toBe('gh-unavailable');
    const merged = report.rows.find((r) => r.path === join(tmp, 'wt-merged'));
    expect(merged.classification).toBe('clean merged (unverified PR)');
    expect(merged.removable).toBe(false);
    expect(merged.complete).toBe(false);
    expect(result.stderr).toContain('PR 查询不完整');
  });

  it('gh 输出坏 JSON → degraded(gh-bad-json)', { timeout: 60_000 }, () => {
    writeGhStub('garbage');
    const report = JSON.parse(runCli(work, ['--json'], cliEnv).stdout);
    expect(report.prLookup).toMatchObject({ status: 'degraded', reason: 'gh-bad-json' });
  });

  it('gh 超时 → degraded(gh-timeout)(SC-T1b-5)', { timeout: 60_000 }, () => {
    writeGhStub('sleep');
    const env = { ...cliEnv, REPO_WORKTREES_GH_TIMEOUT_MS: '300' };
    const report = JSON.parse(runCli(work, ['--json'], env).stdout);
    expect(report.prLookup).toMatchObject({ status: 'degraded', reason: 'gh-timeout' });
  });

  it('open 查询达 limit → 全局 degraded 且 removable 归零(R2 CLA-R2-01)', { timeout: 60_000 }, () => {
    writeGhStub('truncated-open');
    const report = JSON.parse(runCli(work, ['--json'], cliEnv).stdout);
    expect(report.prLookup).toMatchObject({ status: 'degraded', reason: 'gh-open-truncated' });
    expect(report.rows.filter((r) => r.removable)).toHaveLength(0);
  });

  it('仅 all(历史)查询达 limit → 不 degraded,removable 照常(R2 CLA-R2-01/CV2-R2-002)', { timeout: 60_000 }, () => {
    writeGhStub('truncated-history');
    const result = runCli(work, ['--json'], cliEnv);
    const report = JSON.parse(result.stdout);
    // 通道仍 ok、只标 historyTruncated——这是本仓稳态,不得让工具整体失效
    expect(report.prLookup).toMatchObject({ status: 'ok', historyTruncated: true });
    const merged = report.rows.find((r) => r.path === join(tmp, 'wt-merged'));
    expect(merged.classification).toBe('clean merged removable');
    expect(merged.removable).toBe(true);
    expect(result.stderr).toContain('historyTruncated');
  });

  it('gh 行缺必需字段 → degraded(gh-bad-row)(R1 CLA-R1-02)', { timeout: 60_000 }, () => {
    writeGhStub('badrow');
    const report = JSON.parse(runCli(work, ['--json'], cliEnv).stdout);
    expect(report.prLookup).toMatchObject({ status: 'degraded', reason: 'gh-bad-row' });
  });

  it('prunable 行 complete=false(R1 CLA-R1-01:零探针不得冒充已测量)', { timeout: 60_000 }, () => {
    writeGhStub('ok');
    const report = JSON.parse(runCli(work, ['--json'], cliEnv).stdout);
    const gone = report.rows.find((r) => r.path === join(tmp, 'wt-gone'));
    expect(gone.classification).toBe('prunable (path gone)');
    expect(gone.complete).toBe(false);
    // 未测量的 dirty/tracked/untracked 用 null,不用 0 冒充「已测量且干净」
    expect(gone.dirty).toBeNull();
    expect(gone.untracked).toBeNull();
  });

  it('gh 显式 --repo 且不受 GH_REPO 影响(R2 CV2-R2-001)', { timeout: 60_000 }, () => {
    // gh stub 记录自己收到的 argv:必须含 --repo <本仓 slug>,且 GH_REPO 注入不改它
    const argvLog = join(tmp, 'gh-argv.log');
    writeFileSync(join(shimDir, 'gh'), `#!/bin/sh\necho "$@" >> "${argvLog}"\necho "[]"\n`);
    chmodSync(join(shimDir, 'gh'), 0o755);
    rmSync(argvLog, { force: true });

    // ① 注入恶意 GH_REPO/GITHUB_REPOSITORY:必须仍按 origin 解出的 slug 查
    const hijack = { ...cliEnv, GH_REPO: 'attacker/other-repo', GITHUB_REPOSITORY: 'attacker/other-repo' };
    const report = JSON.parse(runCli(work, ['--json'], hijack).stdout);
    expect(report.repoSlug).toBe('fixture-owner/fixture-repo');
    const argv = sh(tmp, 'cat', [argvLog]);
    expect(argv).toContain('--repo fixture-owner/fixture-repo');
    expect(argv).not.toContain('attacker/other-repo');

    // ② origin 解不出 github slug(如本地路径)→ 不查、fail-closed,不猜目标仓
    sh(work, GIT_BIN, ['remote', 'set-url', 'origin', join(tmp, 'origin.git')]);
    const noSlug = JSON.parse(runCli(work, ['--json'], cliEnv).stdout);
    expect(noSlug.prLookup).toMatchObject({ status: 'degraded', reason: 'repo-slug-unresolved' });
    expect(noSlug.repoSlug).toBeNull();
    expect(noSlug.rows.filter((r) => r.removable)).toHaveLength(0);
    sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/fixture-owner/fixture-repo.git']);
  });

  it('parseRepoSlug 解析 ssh/https/带 .git 各形态,非 github 返回 null', () => {
    expect(parseRepoSlug('git@github.com:xindong/mivo-canvas.git')).toBe('xindong/mivo-canvas');
    expect(parseRepoSlug('https://github.com/xindong/mivo-canvas')).toBe('xindong/mivo-canvas');
    expect(parseRepoSlug('https://github.com/xindong/mivo-canvas.git')).toBe('xindong/mivo-canvas');
    expect(parseRepoSlug('/local/path/repo.git')).toBeNull();
    expect(parseRepoSlug('')).toBeNull();
    expect(parseRepoSlug(null)).toBeNull();
  });

  it('外部 GIT_DIR 注入不劫持探针(R1 CV2-R1-001)', { timeout: 120_000 }, () => {
    writeGhStub('ok');
    // 注入 wt-merged 的 .git 定位到环境:未隔离时 `git -C wt-dirty` 会串到 wt-merged,
    // 把 dirty 行读成干净。隔离后各 worktree 探针只认自己的 -C 路径。
    const hijack = { ...cliEnv, GIT_DIR: join(work, '.git'), GIT_WORK_TREE: work };
    const report = JSON.parse(runCli(work, ['--json'], hijack).stdout);
    const byPath = new Map(report.rows.map((r) => [r.path, r]));
    expect(byPath.get(join(tmp, 'wt-dirty')).classification).toBe('dirty WIP');
    expect(byPath.get(join(tmp, 'wt-det-dirty')).classification).toBe('detached dirty danger');
    expect(byPath.get(join(tmp, 'wt-merged')).classification).toBe('clean merged removable');
  });

  it('参数错误 fail-closed;合法 custom base 可用(SC-T1b-3)', { timeout: 60_000 }, () => {
    writeGhStub('ok');
    const bad = [
      [['--nope'], '未知参数'],
      [['--base'], '--base 缺少值'],
      [['--base', '--json'], '--base 缺少值'],
      [['--base=main'], '不支持 --base=<ref>'],
      [['--base', 'main', '--base', 'main'], '--base 重复'],
      [['--base', 'no-such-ref-xyz'], '无法解析为 commit'],
    ];
    for (const [args, message] of bad) {
      const result = runCli(work, ['--json', ...args], cliEnv);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain(message);
    }
    const ok = runCli(work, ['--json', '--base', 'main'], cliEnv);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).base).toBe('main');
  });

  it('机读入口契约:npm run -s repo:worktrees -- --json 的 stdout 可直接 JSON.parse', { timeout: 120_000 }, () => {
    // 裸 npm run 会把 "> mivo@0.0.0 ..." banner 打到 stdout 污染 JSON(R1 验收实测),
    // 机读消费方必须带 -s;本用例在真实仓根锁死该契约。
    const repoRoot = join(import.meta.dirname, '..');
    // 用 --base HEAD:本用例只验 stdout 纯净这一条契约,不该依赖 origin/main
    // 是否已 fetch(那是环境状态,不是本契约的内容)。
    const result = spawnSync('npm', ['run', '-s', 'repo:worktrees', '--', '--json', '--base', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(Array.isArray(report.rows)).toBe(true);
    expect(['ok', 'degraded']).toContain(report.prLookup.status);
  });

  it('表格模式:Base 行 + 表头 + 每个 worktree 一行', { timeout: 60_000 }, () => {
    writeGhStub('ok');
    const result = runCli(work, [], cliEnv);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Base: origin/main');
    expect(result.stdout).toContain('class');
    for (const name of ['wt-dirty', 'wt-merged', 'wt-locked', 'wt-gone']) {
      expect(result.stdout).toContain(join(tmp, name));
    }
  });
});
