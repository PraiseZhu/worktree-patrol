// chain 测试:P1-D 定时链(hook→report(建账+存证+回收+复采)→ack)。
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PATROL = join(import.meta.dirname, '..', 'scripts', 'worktree-patrol.mjs');
const CORE_SCRIPT = join(import.meta.dirname, '..', 'scripts', 'ledger-core.mjs');
const GIT_BIN = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const HOUR = 3600 * 1000;

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trimEnd();
}

const roots = [];
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

function makeChainRepo() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'chain-')));
  roots.push(tmp);
  const origin = join(tmp, 'origin.git');
  const work = join(tmp, 'work');
  sh(tmp, GIT_BIN, ['init', '--bare', '--initial-branch=main', origin]);
  sh(tmp, GIT_BIN, ['clone', origin, work]);
  sh(work, GIT_BIN, ['config', 'user.email', 'f@x.invalid']);
  sh(work, GIT_BIN, ['config', 'user.name', 'f']);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  sh(work, GIT_BIN, ['add', '.']);
  sh(work, GIT_BIN, ['commit', '-m', 'init']);
  sh(work, GIT_BIN, ['push', '-u', 'origin', 'main']);
  sh(work, GIT_BIN, ['remote', 'set-url', 'origin', 'https://github.com/o/r.git']);

  const shimDir = join(tmp, 'shim-bin');
  mkdirSync(shimDir);
  const gitLog = join(tmp, 'git.log');
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
echo "$*" >> "${gitLog}"
if [ -n "$PATROL_SABOTAGE_REMOVE_TARGET" ]; then
  case "$*" in *"worktree remove"*"$PATROL_SABOTAGE_REMOVE_TARGET"*|*"$PATROL_SABOTAGE_REMOVE_TARGET"*) : ;; esac
  case "$*" in *"worktree remove"*)
    case "$*" in *"$PATROL_SABOTAGE_REMOVE_TARGET"*) touch "$PATROL_SABOTAGE_REMOVE_TARGET/injected.txt";; esac
    ;;
  esac
fi
exec "${GIT_BIN}" "$@"
`);
  chmodSync(join(shimDir, 'git'), 0o755);
  writeFileSync(join(shimDir, 'gh'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(shimDir, 'gh'), 0o755);
  const lsofStub = join(tmp, 'lsof-stub');
  writeFileSync(lsofStub, '#!/bin/sh\nexit 1\n');
  chmodSync(lsofStub, 0o755);
  const configPath = join(tmp, 'patrol.config.json');
  writeFileSync(configPath, JSON.stringify({ thresholdHours: 48, allowedRoots: [tmp], residueMaxBytes: 1 << 30, lsofBin: lsofStub, lsofTimeoutMs: 5000 }));
  const stateDir = join(tmp, 'state');
  const baseEnv = {
    ...process.env,
    PATH: `${shimDir}:/usr/bin:/bin`,
    WORKTREE_PATROL_STATE_DIR: stateDir,
    WORKTREE_PATROL_TARGET_REPO: work,
    WORKTREE_PATROL_CONFIG: configPath,
  };
  return {
    tmp, work, stateDir, gitLog, configPath,
    addWorktree(name, { dirty = false, commit = false } = {}) {
      const wt = join(tmp, `wt-${name}`);
      sh(work, GIT_BIN, ['worktree', 'add', wt, '-b', `f-${name}`]);
      if (commit) {
        writeFileSync(join(wt, `${name}.txt`), 'c\n');
        sh(wt, GIT_BIN, ['add', '.']); sh(wt, GIT_BIN, ['commit', '-m', name]);
      }
      if (dirty) writeFileSync(join(wt, `${name}-dirty.txt`), 'd\n');
      return wt;
    },
    run(subcommand, args = [], extraEnv = {}, clockMs) {
      return spawnSync(process.execPath, [PATROL, subcommand, ...args], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...baseEnv, ...extraEnv, ...(clockMs ? { PATROL_NOW_MS: String(clockMs) } : {}) },
      });
    },
    state: () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')),
    pendingId: (stdout) => stdout.match(/PENDING_ID=(\S+)/)?.[1],
    writeGitCalls: () => (existsSync(gitLog) ? readFileSync(gitLog, 'utf8').split('\n').filter(Boolean).filter((line) => {
      const tokens = line.split(' ');
      let i = 0;
      while (tokens[i] === '-C') i += 2;
      const sub = tokens[i];
      if (['stash', 'update-ref', 'bundle', 'branch', 'push', 'commit'].includes(sub)) return true;
      return sub === 'worktree' && ['remove', 'prune', 'unlock', 'lock', 'move', 'add'].includes(tokens[i + 1]);
    }) : []),
  };
}

describe('patrol chain(P1-D)', () => {
  it('全链成功:四分区并集==cohort、pending=post-reclaim、ack 后 hook exit 2 零写(D SC1/SC2/SC4)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    repo.addWorktree('old1', { commit: true });          // reclaim(unpushed)
    repo.addWorktree('old2');                            // reclaim(clean)
    const recentDirty = repo.addWorktree('fresh', { dirty: true }); // keep(recent-loss)——mtime 是真实 now,相对 T0 是 100 天前?
    // fresh 要成为 recent-loss 需 activity 距 T0 <= 48h:把 dirty 文件 mtime 拨到 T0-1h
    const freshDate = new Date(T0 - HOUR);
    execFileSync('touch', ['-t', toTouch(freshDate), join(recentDirty, 'fresh-dirty.txt')]);
    execFileSync('touch', ['-t', toTouch(freshDate), recentDirty]);

    // report
    const report = repo.run('report', [], {}, T0);
    expect(report.status, report.stdout + report.stderr).toBe(0);
    const pendingId = repo.pendingId(report.stdout);
    expect(pendingId).toBeTruthy();
    const pending = repo.state().pending;
    expect(pending.ok).toBe(true);
    // 四分区并集 == cohort(primary=keep + old1/old2=reclaimed + fresh=keep)
    const union = pending.parts.reclaimed.length + pending.parts.keep.length + pending.parts.unledgerable.length + pending.parts.failed.length;
    expect(union).toBe(4);
    expect(pending.parts.reclaimed.length).toBe(2);
    expect(pending.parts.keep.length).toBe(2);
    // 通知文本四分区可见
    expect(report.stdout).toContain('已清 2');
    expect(report.stdout).toContain('保留 2');
    // pending.postHash == 复采(post-reclaim)的 registry
    const registryNow = sh(repo.work, GIT_BIN, ['worktree', 'list', '--porcelain']);
    expect(registryNow.includes('wt-old1')).toBe(false); // 已清
    // ack
    const ack = repo.run('ack', ['--pending', pendingId], {}, T0);
    expect(ack.status, ack.stderr).toBe(0);
    expect(repo.state().pending).toBe(null);
    // hook:固定时钟、无变化 → exit 2,全程零写
    rmSync(repo.gitLog, { force: true });
    const stateBefore = statSync(join(repo.stateDir, 'state.json')).mtimeMs;
    const hook = repo.run('hook', [], {}, T0 + HOUR);
    expect(hook.status).toBe(2);
    expect(repo.writeGitCalls()).toEqual([]);
    expect(statSync(join(repo.stateDir, 'state.json')).mtimeMs).toBe(stateBefore);
    // deadline 到期(fresh 的 activityAt+48h):hook 必 exit 0,即使 registry 未变(D SC4)
    const overDeadline = repo.run('hook', [], {}, T0 + 50 * HOUR);
    expect(overDeadline.status).toBe(0);
    expect(overDeadline.stderr).toContain('到期');
  });

  it('config 指纹变化 → registry 字节不变也 hook exit 0(D SC4)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    const report = repo.run('report', [], {}, T0);
    expect(report.status).toBe(0);
    expect(repo.run('ack', ['--pending', repo.pendingId(report.stdout)], {}, T0).status).toBe(0);
    expect(repo.run('hook', [], {}, T0).status).toBe(2);
    // 改 config(阈值 48→24)
    writeFileSync(repo.configPath, JSON.stringify({ thresholdHours: 24, allowedRoots: [repo.tmp], residueMaxBytes: 1 << 30, lsofBin: join(repo.tmp, 'lsof-stub'), lsofTimeoutMs: 5000 }));
    const hook = repo.run('hook', [], {}, T0);
    expect(hook.status).toBe(0);
    expect(hook.stderr).toContain('config 指纹变化');
  });

  it('source 指纹变化 → hook exit 0(D SC5;临时改判定源码后还原)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    const report = repo.run('report', [], {}, T0);
    expect(report.status).toBe(0);
    expect(repo.run('ack', ['--pending', repo.pendingId(report.stdout)], {}, T0).status).toBe(0);
    expect(repo.run('hook', [], {}, T0).status).toBe(2);
    const original = readFileSync(CORE_SCRIPT, 'utf8');
    try {
      appendFileSync(CORE_SCRIPT, '\n// source-fingerprint-mutation-test\n');
      const hook = repo.run('hook', [], {}, T0);
      expect(hook.status).toBe(0);
      expect(hook.stderr).toContain('源码指纹变化');
    } finally {
      writeFileSync(CORE_SCRIPT, original);
    }
  });

  it('注入 reclaim 失败:他项照清、通知带 failed、ack 拒绝、次轮 hook exit 0(D SC3)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    repo.addWorktree('ok1');
    const victim = repo.addWorktree('victim');
    const report = repo.run('report', [], { PATROL_SABOTAGE_REMOVE_TARGET: victim }, T0);
    expect(report.status).not.toBe(0); // fail-visible
    // 他项仍执行
    expect(existsSync(join(repo.tmp, 'wt-ok1'))).toBe(false);
    expect(existsSync(victim)).toBe(true);
    // 通知照发且列出 failed
    expect(report.stdout).toContain('PENDING_ID=');
    expect(report.stdout).toMatch(/失败·漂移·冲突 1|failed/);
    expect(report.stdout).toContain('wt-victim');
    // ack 拒绝,pending 保留
    const ack = repo.run('ack', ['--pending', repo.pendingId(report.stdout)], {}, T0);
    expect(ack.status).not.toBe(0);
    expect(ack.stderr).toContain('拒绝晋升');
    expect(repo.state().pending).not.toBe(null);
    // 次轮 hook:即使什么都没再变,pending 未确认 → exit 0
    const hook = repo.run('hook', [], {}, T0);
    expect(hook.status).toBe(0);
    expect(hook.stderr).toContain('pending');
  });

  it('受保护项消失:外部删除 keep 项 → 报警;本工具已清项按台账豁免(D SC5)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    repo.addWorktree('gone-soon'); // 将被本工具清掉(豁免对照)
    const kept = repo.addWorktree('kept', { dirty: true });
    execFileSync('touch', ['-t', toTouch(new Date(T0 - HOUR)), join(kept, 'kept-dirty.txt')]);
    execFileSync('touch', ['-t', toTouch(new Date(T0 - HOUR)), kept]);
    const r1 = repo.run('report', [], {}, T0);
    expect(r1.status, r1.stdout + r1.stderr).toBe(0);
    expect(repo.run('ack', ['--pending', repo.pendingId(r1.stdout)], {}, T0).status).toBe(0);
    // 外部暴力删除 keep 项(绕过本工具)
    sh(repo.work, GIT_BIN, ['worktree', 'remove', '--force', kept]);
    const r2 = repo.run('report', [], {}, T0 + HOUR);
    // 报警在,且不把 wt-gone-soon(本工具上轮已清)报成消失
    expect(r2.stdout).toContain('受保护项消失');
    expect(r2.stdout).toContain('wt-kept');
    expect(r2.stdout).not.toContain('gone-soon(原');
  });

  it('ack 绑定:ack 前 registry 又变 → pending 过期拒绝(D SC1)', { timeout: 300_000 }, () => {
    const repo = makeChainRepo();
    const T0 = Date.now() + 100 * 24 * HOUR;
    const report = repo.run('report', [], {}, T0);
    expect(report.status).toBe(0);
    // run 结束后、ack 前,又冒出新 worktree
    repo.addWorktree('interloper');
    const ack = repo.run('ack', ['--pending', repo.pendingId(report.stdout)], {}, T0);
    expect(ack.status).not.toBe(0);
    expect(ack.stderr).toContain('registry 已漂移');
    expect(repo.state().pending).not.toBe(null);
  });
});

function toTouch(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}
