// ledger-core — 台账纯函数核心(零 I/O):config 校验 / entry 身份与 schema /
// activity 计算 / 处置策略(硬保留门 OR)。共识依据: _tmp/plan-review-r1 R1 共识
// (gpt-5.6-sol AMEND 全盘采用 + 阈值 T 默认 48h、lsof 三态 两参数 ACK)。
//
// 设计不变量(与 repo-worktrees-core 同一立场,fail-closed):
//   - 策略只消费 raw evidence,不消费 classification 摘要字符串——dirty+sentinel/
//     dirty+locked/dirty+OPEN-PR 组合下任何单一摘要都会丢门(共识风险 12)。
//   - 硬保留门独立求 OR,收集**全部**命中理由,不短路。
//   - 任一承重探针错误 → unledgerable,绝不 reclaim。
//   - primary checkout 按仓根身份判定,不按 branch 名(共识风险 1: 主仓根当前
//     停在 feature 分支,branch=main 判定会保护错对象)。

import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA_VERSION = 1;

// ── config ──────────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLD_HOURS = 48;

const CONFIG_KEYS = new Set([
  'thresholdHours', 'allowedRoots', 'residueMaxBytes', 'lsofBin', 'lsofTimeoutMs',
]);

/**
 * config 校验(P0-C SC4):未知键/负数/NaN/非绝对路径/roots 相互重叠 → 整体拒绝。
 * 返回 {ok:true, config} 或 {ok:false, errors:[...]};拒绝时调用方必须拒绝整轮 reclaim。
 * 注意 allowedRoots 此处只做词法校验;realpath 归一由调用方(有 I/O)完成后再传入。
 */
export function validateConfig(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['config 必须是对象'] };
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`未知配置键: ${key}`);
  }
  const thresholdHours = raw.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
  if (typeof thresholdHours !== 'number' || !Number.isFinite(thresholdHours) || thresholdHours < 0) {
    errors.push(`thresholdHours 必须是 >=0 的有限数(0 合法),得到: ${String(thresholdHours)}`);
  }
  const allowedRoots = raw.allowedRoots;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    errors.push('allowedRoots 必须是非空数组');
  } else {
    for (const root of allowedRoots) {
      if (typeof root !== 'string' || !root.startsWith('/')) {
        errors.push(`allowedRoots 路径必须是绝对路径: ${String(root)}`);
      } else if (root !== '/' && root.endsWith('/')) {
        errors.push(`allowedRoots 路径不得带尾斜杠(边界比较用 path+'/'): ${root}`);
      }
    }
    // 重叠越权:任一 root 是另一 root 的祖先 → 拒绝(边界语义会歧义)
    for (const a of allowedRoots) {
      for (const b of allowedRoots) {
        if (a !== b && typeof a === 'string' && typeof b === 'string' && `${b}/`.startsWith(`${a}/`)) {
          errors.push(`allowedRoots 重叠: ${a} 覆盖 ${b}`);
        }
      }
    }
  }
  const residueMaxBytes = raw.residueMaxBytes ?? 2 * 1024 * 1024 * 1024;
  if (typeof residueMaxBytes !== 'number' || !Number.isFinite(residueMaxBytes) || residueMaxBytes <= 0) {
    errors.push('residueMaxBytes 必须是 >0 的有限数');
  }
  const lsofBin = raw.lsofBin ?? '/usr/sbin/lsof';
  if (typeof lsofBin !== 'string' || !lsofBin.startsWith('/')) {
    errors.push('lsofBin 必须是绝对路径');
  }
  const lsofTimeoutMs = raw.lsofTimeoutMs ?? 10_000;
  if (typeof lsofTimeoutMs !== 'number' || !Number.isFinite(lsofTimeoutMs) || lsofTimeoutMs <= 0) {
    errors.push('lsofTimeoutMs 必须是 >0 的有限数');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { thresholdHours, allowedRoots: [...allowedRoots], residueMaxBytes, lsofBin, lsofTimeoutMs },
  };
}

// ── 身份 ────────────────────────────────────────────────────────────────────

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** entry 身份 = 仓身份(commonDir realpath) + porcelain 字面路径。稳定、与扫描顺序无关。 */
export function deriveEntryId(commonDirReal, literalPath) {
  return `e-${sha256(`${commonDirReal}\0${literalPath}`).slice(0, 20)}`;
}

// ── evidence schema(P0-A SC2) ──────────────────────────────────────────────

// 承重字段:缺任一 → 只允许 unledgerable。undefined 与 null 都算缺
// (探针必须显式写入测得值;null 表示"测过但无值"的字段单列在 NULLABLE 里)。
const REQUIRED_EVIDENCE_FIELDS = [
  'repoRoot', 'commonDir', 'literalPath', 'porcelainBlockHash',
  'isPrimary', 'lstatType', 'realpath', 'gitDir', 'head',
  'detached', 'locked', 'prunable', 'keepSentinel', 'prLookup', 'loss', 'activity',
  'underAllowedRoot',
];
// 允许为 null 的承重字段(仍必须显式存在): branch(detached 时无)、realpath/gitDir/head
// 在 fs-missing 场景无法取得——但那类场景本就走 unledgerable,不需要通过本校验。
const NULLABLE_FIELDS = new Set(['branch']);

/**
 * evidence 完整性校验。返回缺失/非法字段清单;非空时调用方只能记 unledgerable。
 */
export function validateEvidence(evidence) {
  const problems = [];
  if (evidence === null || typeof evidence !== 'object') return ['evidence 不是对象'];
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    const value = evidence[field];
    if (value === undefined) problems.push(`缺承重字段: ${field}`);
    else if (value === null && !NULLABLE_FIELDS.has(field)) problems.push(`承重字段为 null: ${field}`);
  }
  if (evidence.keepSentinel !== undefined && evidence.keepSentinel !== null) {
    if (!['present', 'absent'].includes(evidence.keepSentinel) && !String(evidence.keepSentinel).startsWith('error:')) {
      problems.push(`keepSentinel 必须是 present|absent|error:<code>: ${evidence.keepSentinel}`);
    }
  }
  const loss = evidence.loss;
  if (loss && typeof loss === 'object') {
    for (const k of ['staged', 'unstaged', 'untracked', 'ignored', 'unreachableCommits']) {
      if (typeof loss[k] !== 'number' || !Number.isFinite(loss[k]) || loss[k] < 0) {
        problems.push(`loss.${k} 必须是 >=0 的数: ${String(loss[k])}`);
      }
    }
    for (const k of ['submoduleDirty', 'nestedRepos', 'detachedUnanchored']) {
      if (!(k in loss)) problems.push(`loss 缺字段: ${k}`);
    }
  }
  const act = evidence.activity;
  if (act && typeof act === 'object') {
    if (typeof act.activityAt !== 'number' || !Number.isFinite(act.activityAt)) {
      problems.push(`activity.activityAt 必须是有限毫秒时间戳: ${String(act.activityAt)}`);
    }
    if (!Array.isArray(act.evidence) || act.evidence.length === 0) {
      problems.push('activity.evidence 必须是非空数组(取值来源可追溯)');
    }
  }
  return problems;
}

// ── activity(P0-C SC3) ─────────────────────────────────────────────────────

/**
 * activityAt = max(HEAD committer time, worktree 根 mtime, loss 涉及路径最大 mtime)。
 * 输入是探针层已测得的原始毫秒值(可为 null=stat 失败);任一来源失败 → {error}
 * (fail-closed,调用方按 unledgerable 处理——「不知道多新」不能当「够旧」)。
 */
export function computeActivity({ headCommitMs, rootMtimeMs, lossPathsMaxMtimeMs, lossPathsProbed }) {
  const evidence = [];
  if (typeof headCommitMs !== 'number' || !Number.isFinite(headCommitMs)) {
    return { error: `HEAD committer time 不可得: ${String(headCommitMs)}` };
  }
  evidence.push({ source: 'head-committer-time', valueMs: headCommitMs });
  if (typeof rootMtimeMs !== 'number' || !Number.isFinite(rootMtimeMs)) {
    return { error: `worktree 根 mtime 不可得: ${String(rootMtimeMs)}` };
  }
  evidence.push({ source: 'root-mtime', valueMs: rootMtimeMs });
  let max = Math.max(headCommitMs, rootMtimeMs);
  if (lossPathsProbed) {
    if (typeof lossPathsMaxMtimeMs !== 'number' || !Number.isFinite(lossPathsMaxMtimeMs)) {
      return { error: 'loss 路径 mtime 探测失败' };
    }
    evidence.push({ source: 'loss-paths-max-mtime', valueMs: lossPathsMaxMtimeMs });
    max = Math.max(max, lossPathsMaxMtimeMs);
  }
  return { activityAt: max, evidence };
}

// ── 处置策略(P0-C SC1..5) ──────────────────────────────────────────────────

export const DISPOSITIONS = ['reclaim', 'keep', 'unledgerable'];

function hasLoss(loss) {
  return (
    loss.staged > 0 || loss.unstaged > 0 || loss.untracked > 0 || loss.ignored > 0 ||
    loss.unreachableCommits > 0 || loss.detachedUnanchored === true
  );
}

/** 从 loss manifest 派生存证计划(B0 消费;顺序即执行顺序)。 */
export function derivePreservationPlan(evidence) {
  const plan = [];
  const { loss } = evidence;
  // 分支/HEAD 锚定:凡有本地提交不在远端(或 detached),先锚对象再动目录
  if (loss.unreachableCommits > 0 || evidence.detached) plan.push('archive-ref');
  if (loss.unreachableCommits > 0) plan.push('bundle');
  if (loss.staged > 0 || loss.unstaged > 0 || loss.untracked > 0) plan.push('stash-snapshot');
  if (loss.ignored > 0) plan.push('residue-archive');
  return plan;
}

/**
 * 处置裁决。纯函数;liveProbe 传 null 表示尚未探(两阶段:先裁,候选为 reclaim 的
 * 才跑 lsof,再终裁——探针只对 reclaim 候选执行是 ACK 文本的硬要求)。
 *
 * 返回 { disposition, reasons[], preservationPlan?, requiresLiveProbe? }。
 * reasons 收集全部命中理由(硬门独立求 OR 不短路,P0-C SC1)。
 */
export function decideDisposition(evidence, config, nowMs, liveProbe = null) {
  // 0) evidence 完整性:缺承重字段/探针错误 → unledgerable(P0-A SC2)
  const schemaProblems = validateEvidence(evidence);
  if (schemaProblems.length > 0) {
    return { disposition: 'unledgerable', reasons: schemaProblems.map((p) => `schema: ${p}`) };
  }
  if (Array.isArray(evidence.probeErrors) && evidence.probeErrors.length > 0) {
    return { disposition: 'unledgerable', reasons: evidence.probeErrors.map((e) => `probe: ${e}`) };
  }
  // 0b) 目录已不在(prunable/missing):v1 零 prune,建不了损失性证明
  if (evidence.prunable || evidence.lstatType === 'missing') {
    return { disposition: 'unledgerable', reasons: ['stale-registry: 目录已不在,v1 零 prune 零删除'] };
  }
  if (evidence.lstatType !== 'dir') {
    return { disposition: 'unledgerable', reasons: [`lstat 类型异常: ${evidence.lstatType}(注册路径不是目录)`] };
  }
  // 0c) v1 不支持的损失形态:嵌套仓/脏子模块无等价归档,不得冒充可存证(B0 SC4)
  if (evidence.loss.nestedRepos > 0) {
    return { disposition: 'unledgerable', reasons: [`unsupported-loss-shape: 含 ${evidence.loss.nestedRepos} 个嵌套 git 仓,v1 无等价归档`] };
  }
  if (evidence.loss.submoduleDirty === true) {
    return { disposition: 'unledgerable', reasons: ['unsupported-loss-shape: submodule dirty,v1 无等价归档'] };
  }
  if (evidence.loss.submoduleDirty === null) {
    return { disposition: 'unledgerable', reasons: ['probe: submodule 状态不可判'] };
  }

  // 1) 硬保留门:独立求 OR,收集全部理由(P0-C SC1)
  const keeps = [];
  if (evidence.isPrimary) keeps.push('primary-checkout: 仓根现场,任何配置下永不动');
  if (evidence.keepSentinel === 'present') keeps.push('sentinel: .worktree-keep 在场');
  if (String(evidence.keepSentinel).startsWith('error:')) {
    keeps.push(`sentinel-unknown: 哨兵探测 ${evidence.keepSentinel},按存在保留(P0-C SC5)`);
  }
  if (evidence.locked) keeps.push(`locked: ${evidence.lockedReason || '(无理由)'}`);

  const pr = evidence.prLookup;
  if (pr.status === 'ok') {
    if (!evidence.detached && evidence.branch && pr.openHeadRefNames.includes(evidence.branch)) {
      keeps.push(`open-pr: 分支 ${evidence.branch} 有在途 PR`);
    }
    if (evidence.detached && pr.openHeadOids.includes(evidence.head)) {
      keeps.push(`open-pr-detached-oid: HEAD ${evidence.head.slice(0, 12)} 是某在途 PR 的 head(共识风险 5)`);
    }
  }
  if (liveProbe === 'observed-live') keeps.push('observed-live: lsof 观察到进程持有该目录');
  if (liveProbe === 'live-probe-unknown') keeps.push('live-probe-unknown: 探活不可判,fail-closed 保留');

  if (keeps.length > 0) return { disposition: 'keep', reasons: keeps };

  // 2) 无正向 keep 且 PR 通道不完整 → 「无在途 PR」这条负证据拿不到(P0-A SC4)
  if (pr.status !== 'ok') {
    return { disposition: 'unledgerable', reasons: [`pr-unverified: PR 查询通道 ${pr.reason ?? 'degraded'},「无在途 PR」负证据不可得`] };
  }

  // 2b) 作用域门:不在 allowedRoots 内的目录不参与自动清理(删除器的 allowed-root
  // 硬门在 B 层还会再验;这里提前 keep 让台账语义诚实——"没授权动"而非"该动没动")
  if (evidence.underAllowedRoot !== true) {
    return { disposition: 'keep', reasons: ['out-of-scope: realpath 不在 config.allowedRoots 内,自动清理无授权'] };
  }

  // 3) recent-loss 门:activityAge <= T 且有损失内容 → keep(边界含等号,ACK 固定)
  const thresholdMs = config.thresholdHours * 3600 * 1000;
  const age = nowMs - evidence.activity.activityAt;
  if (hasLoss(evidence.loss) && age <= thresholdMs) {
    const anomaly = age < 0 ? '(activityAt 在未来,时钟异常按最近处理)' : '';
    return {
      disposition: 'keep',
      reasons: [`recent-loss: 活动距今 ${Math.round(age / 3600000)}h <= 阈值 ${config.thresholdHours}h${anomaly},到期后自动重裁`],
      deadlineMs: evidence.activity.activityAt + thresholdMs,
    };
  }

  // 4) reclaim 候选:live 探针未跑时先返回 requiresLiveProbe,不给终裁
  if (liveProbe === null) {
    return { disposition: 'reclaim', reasons: ['候选: 全部硬门通过,待 observed-live 终验'], requiresLiveProbe: true, preservationPlan: derivePreservationPlan(evidence) };
  }
  if (liveProbe !== 'no-observed-live') {
    return { disposition: 'unledgerable', reasons: [`live-probe 结果非法: ${String(liveProbe)}`] };
  }
  return {
    disposition: 'reclaim',
    reasons: ['全部硬保留门未命中、损失内容超过阈值窗口或为空、无进程占用'],
    preservationPlan: derivePreservationPlan(evidence),
  };
}

// ── canonical 序列化(P0-A SC5) ─────────────────────────────────────────────

/** 递归按键名排序,保证 JSON.stringify 字节稳定。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// 幂等比较时剔除的 volatile 字段(envelope 层时间戳;entry 本体不含挂钟时间)
const VOLATILE_KEYS = new Set(['recordedAt', 'runId', 'generatedAt', 'cohortHash']);

export function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalEntriesText(entries) {
  return JSON.stringify(stripVolatile(canonicalize(entries)));
}
