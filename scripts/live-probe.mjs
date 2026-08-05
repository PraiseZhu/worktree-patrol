// live-probe — observed-live 探针(共识 ACK 硬化文本的逐字实现)。
// 只对「通过其余硬门、即将进入 reclaim」的 canonical realpath 执行;argv 方式禁 shell;
// 三态语义:
//   (a) exit 0 且解析出至少一个进程记录            → 'observed-live'
//   (b) exit 1 且 stdout/stderr 均空 且前后身份校验通过 → 'no-observed-live'
//   (c) 其余一切(不存在/timeout/signal/非0-1退出/exit1带stderr/输出不可解析/身份漂移)
//                                                  → 'live-probe-unknown'
// ledger reason 只准写 observed-live / live-probe-unknown,不得写成"确认无 session
// lease"——lsof 证明的是「观察到 handle」,证明不了「所有编辑器/agent 都不存在」。

import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';

function identitySnapshot(targetRealpath) {
  try {
    const stat = lstatSync(targetRealpath);
    if (!stat.isDirectory()) return { ok: false, reason: `lstat 非目录` };
    const real = realpathSync(targetRealpath);
    if (real !== targetRealpath) return { ok: false, reason: `realpath 漂移: ${real}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `lstat/realpath 失败: ${error?.code ?? error}` };
  }
}

/**
 * @param targetRealpath 已 canonical 化的 worktree realpath
 * @param config         validateConfig 产物(lsofBin/lsofTimeoutMs)
 * @returns {{result:'observed-live'|'no-observed-live'|'live-probe-unknown', detail:string}}
 */
export function probeObservedLive(targetRealpath, config) {
  const before = identitySnapshot(targetRealpath);
  if (!before.ok) return { result: 'live-probe-unknown', detail: `pre-identity: ${before.reason}` };

  let proc;
  try {
    proc = spawnSync(config.lsofBin, ['-nP', '-F', 'pcn', '+D', targetRealpath], {
      encoding: 'utf8',
      timeout: config.lsofTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    return { result: 'live-probe-unknown', detail: `spawn 异常: ${error?.code ?? error}` };
  }
  if (proc.error) {
    return { result: 'live-probe-unknown', detail: `执行失败: ${proc.error.code ?? proc.error.message}` };
  }
  if (proc.signal) {
    return { result: 'live-probe-unknown', detail: `被信号终止(timeout?): ${proc.signal}` };
  }

  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  // -F 字段输出:进程记录以 'p<pid>' 行开头
  const hasProcess = stdout.split('\n').some((line) => /^p\d+$/.test(line.trim()));

  // 与 ACK 文本的一处经实测校正的偏差(方向只会更保守地 keep,不影响删除安全):
  // 真实 lsof 的 +D 语义是「目录树内任一文件无打开描述符即 exit 1」,所以
  // 「找到了占用进程」的常见真实形态是 exit 1 + stdout 有 p 记录(stderr 空)。
  // 按 ACK 字面它落 (c) unknown——结果同为 keep,但台账理由失真('unknown' 而非
  // 'observed-live')。此处把 exit 0/1 且解析出进程记录统一判 observed-live;
  // no-observed-live 仍只有唯一形态:exit 1 + stdout/stderr 全空 + 身份复验通过。
  if ((proc.status === 0 || proc.status === 1) && hasProcess && stderr === '') {
    return { result: 'observed-live', detail: '观察到进程持有该目录树内文件/cwd' };
  }
  if (proc.status === 0) {
    return { result: 'live-probe-unknown', detail: 'exit 0 但无可解析进程记录' };
  }
  if (proc.status === 1) {
    if (stdout === '' && stderr === '') {
      const after = identitySnapshot(targetRealpath);
      if (!after.ok) return { result: 'live-probe-unknown', detail: `post-identity: ${after.reason}` };
      return { result: 'no-observed-live', detail: '纯空输出 exit 1,未观察到占用' };
    }
    return { result: 'live-probe-unknown', detail: `exit 1 但输出非空且无进程记录(stderr=${stderr.slice(0, 120)})` };
  }
  return { result: 'live-probe-unknown', detail: `非 0/1 退出码: ${proc.status}` };
}
