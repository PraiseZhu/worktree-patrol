// repo-worktrees 纯判定核心:porcelain 解析 + 风险分类。
// 本模块无任何 I/O——全部输入由 CLI(repo-worktrees.mjs)探针采集后传入,便于 fixture 单测。
//
// 设计来源:cindy 仓 scripts/repo-worktrees.mjs(检出 6e8487a19)移植加固,加固点:
//  1. 识别 porcelain 的 locked / prunable 标记,新增 missing(目录不存在)与
//     unknown(探针失败)分类——原实现会把丢失目录的注册项折叠成 detached clean,
//     恰好把最需要人工确认的状态标成了低风险。
//  2. unknown / 探针不完整一律 fail-closed:绝不落入 removable。
//  3. active PR 优先于 clean merged removable:报告层也不允许「HEAD 已合入」
//     掩盖「还有在途 PR」。
//  4. PR 关联携带 head SHA 绑定状态(boundToHead);PR 查询失败由调用方显式标记
//     degraded,本模块把「查询不完整」与「确认没有 PR」当作两种不同输入——
//     **且该区分在每个出口都要落到 reasons 上**,不只在 inBase 出口(R2 CLA-R2-02:
//     此前非 inBase 的三个出口在 degraded 下仍肯定断言「无关联 PR」,实测 5 个持有
//     OPEN PR 的分支被误报)。
//  5. .worktree-keep 哨兵:视为人工 opt-in 保留,永不 removable;哨兵文件本身
//     不计入 dirty(否则「放哨兵」与「保持干净」互斥,哨兵机制无法成立)。
//  6. 输入缺字段即 fail-closed(R2 CLA-R2-06:漏传 dirty 曾能得出 removable=true,
//     方向是 fail-open)——承重字段必须实际取到值,不接受 undefined。

export const KEEP_SENTINEL = '.worktree-keep';

// classify 的承重输入:任一为 undefined 即 fail-closed(不猜、不用默认值兜)。
// dirty/inBase 允许为 null(= 未测量),但那时必须由 prunable/missing/probeErrors
// 之一解释;否则视为输入不自洽,同样 fail-closed。
const REQUIRED_FIELDS = ['prunable', 'missing', 'probeErrors', 'locked', 'detached', 'dirty', 'inBase', 'hasKeep', 'prLookupOk'];

// 分类 → 风险排序(越小越危险,报告按此排序)。固定分类 16 个;动态的 `PR <state>`
// 族不在表内,取 DEFAULT_RANK(紧随 clean branch 之后)。
export const CLASSIFICATION_RANK = {
  'input incomplete (fail-closed)': 0,
  'missing (unknown state)': 1,
  'unknown (probe failed)': 2,
  'detached dirty danger': 3,
  'HEAD merged, worktree dirty': 4,
  'dirty WIP': 5,
  'locked': 6,
  'active PR': 7,
  'local unpushed feature': 8,
  'keep sentinel': 9,
  // 两个同族 fail-closed 的 clean-merged 变体必须相邻,中间不夹更低风险的分类
  // (R2 U-493-07:未登记时落 DEFAULT_RANK,被排到 clean branch 之后)
  'clean merged (unverified PR)': 10,
  'clean merged (PR head 未绑定)': 11,
  'clean branch': 12,
  'detached clean': 14,
  'prunable (path gone)': 15,
  'clean merged removable': 16,
  'main clean': 17,
};
export const DEFAULT_RANK = 13;

export function rankOf(classification) {
  return CLASSIFICATION_RANK[classification] ?? DEFAULT_RANK;
}

// 解析 `git worktree list --porcelain` 输出。
// 每块的已知键:worktree / HEAD / branch / detached / locked [reason] / prunable [reason]。
// locked、prunable 可能带一段自由文本原因(同一行空格后),也可能裸键无值。
export function parsePorcelainWorktrees(text) {
  return text
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const item = {
        path: null,
        head: null,
        branchRef: null,
        detached: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      };
      for (const line of block.split('\n')) {
        const sp = line.indexOf(' ');
        const key = sp === -1 ? line : line.slice(0, sp);
        const value = sp === -1 ? null : line.slice(sp + 1);
        if (key === 'worktree') item.path = value;
        else if (key === 'HEAD') item.head = value;
        else if (key === 'branch') item.branchRef = value;
        else if (key === 'detached') item.detached = true;
        else if (key === 'locked') {
          item.locked = true;
          item.lockedReason = value;
        } else if (key === 'prunable') {
          item.prunable = true;
          item.prunableReason = value;
        }
      }
      return item;
    });
}

// 风险分类。输入 row 字段(由 CLI 组装):
//   prunable, missing, probeErrors[], locked, detached, dirty, inBase, hasKeep,
//   branch, upstream('none'|ref|null), aheadOfUpstream(number|null),
//   pr({state,...}|null), prLookupOk(boolean — PR 查询通道本身是否完整)
// 返回 { classification, removable, reasons[] }。
// removable=true 是唯一允许自动化删除流程消费的信号,其余分类一律拒绝。
export function classify(row) {
  // PR 通道不完整时,**每个**出口的 reasons 都要带上这句——不让任何一条结论在
  // degraded 下被读成「已确认 PR 状态」(R2 CLA-R2-02)。
  const prCaveat = row?.prLookupOk === false ? ['PR 查询通道不完整:本行的 PR 关联未知,不得据此判断在途 PR'] : [];
  const keep = (classification, ...reasons) => ({ classification, removable: false, reasons: [...reasons, ...prCaveat] });

  // 承重输入缺字段 → fail-closed。漏传任一字段时 JS 的 undefined 比较会静默走成
  // 「干净/已合入」,方向是 fail-open(R2 CLA-R2-06 实测漏传 dirty 得到 removable=true)。
  const missingFields = REQUIRED_FIELDS.filter((f) => row?.[f] === undefined);
  if (missingFields.length > 0) {
    return keep('input incomplete (fail-closed)', `classify 输入缺承重字段: ${missingFields.join(', ')}——拒绝给出风险判定`);
  }
  // dirty/inBase 为 null(未测量)只在 prunable/missing/探针失败时合法;否则输入不自洽。
  const unmeasured = (row.dirty === null || row.inBase === null)
    && !row.prunable && !row.missing && row.probeErrors.length === 0;
  if (unmeasured) {
    return keep('input incomplete (fail-closed)', 'dirty/inBase 为未测量(null)却无 prunable/missing/探针失败解释,输入不自洽');
  }

  // prunable 在 missing 之前:porcelain 已给出更精确的结论(注册项待 prune),
  // 处置动作是 `git worktree prune`,不是分支清理,二者不可混。
  if (row.prunable) {
    return keep('prunable (path gone)', 'porcelain 标记 prunable:目录已消失,仅可 git worktree prune 注册项,不构成分支处置依据');
  }
  if (row.missing) {
    return keep('missing (unknown state)', 'worktree 目录不存在或不可读且未被 git 标记 prunable,状态未知,fail-closed');
  }
  if (row.probeErrors.length > 0) {
    return keep('unknown (probe failed)', ...row.probeErrors.map((e) => `探针失败: ${e}`));
  }
  if (row.locked) {
    return keep('locked', `git worktree lock 保护中${row.lockedReason ? `(${row.lockedReason})` : ''}`);
  }
  if (row.detached && row.dirty > 0) {
    return keep('detached dirty danger', 'detached HEAD 且有未提交改动,删除即永久丢失');
  }
  if (row.dirty > 0 && row.inBase) {
    return keep('HEAD merged, worktree dirty', '分支已合入基线但工作区有未提交改动(dirty-tail),需人工判断弃留');
  }
  if (row.dirty > 0) {
    return keep('dirty WIP', '在途工作,有未提交改动');
  }
  // active PR 必须先于一切 removable 判定(含 inBase):在途 PR 的 worktree 一律不动。
  if (row.pr && row.pr.state === 'OPEN') {
    return keep('active PR', `关联 open PR #${row.pr.number}${row.pr.isDraft ? '(draft)' : ''},勿动`);
  }
  if (row.hasKeep) {
    return keep('keep sentinel', `${KEEP_SENTINEL} 哨兵存在:人工 opt-in 保留,移除哨兵前不得清理`);
  }
  if (row.detached) {
    return keep('detached clean', 'detached 临时检出且干净;无分支语义,确认无用后可人工移除 worktree');
  }
  if (row.branch === 'main') {
    // 「基线现场」必须三条都成立:不领先 upstream、HEAD 是所选 base 的祖先、相对 base
    // 零领先。只判 aheadOfUpstream 会让「main 无 upstream 且领先 base」落进 main clean
    // (R2 CV2-R2-003:该状态下 inBase=false/ahead=1 被整体忽略)。
    if ((row.aheadOfUpstream ?? 0) > 0) {
      return keep('local unpushed feature', 'main 本地领先 upstream,有未 push 提交,不是干净基线');
    }
    if (row.inBase !== true || (row.ahead ?? 0) > 0) {
      return keep('local unpushed feature', `main 相对基线不同步(inBase=${row.inBase}, ahead=${row.ahead ?? '?'}),不是干净基线`);
    }
    return keep('main clean', 'main 基线现场');
  }
  // inBase 先于「无 upstream / 领先 upstream」:HEAD 是基线祖先时,全部提交都
  // 可从基线到达,删除不丢任何内容——upstream 状态不改变这个可达性事实。
  if (row.inBase) {
    if (!row.prLookupOk) {
      return keep('clean merged (unverified PR)', 'HEAD 已在基线且工作区干净,但 PR 查询通道不完整,无法排除在途 PR,fail-closed');
    }
    // 查到了关联 PR 但其 headRefOid 未绑定当前 HEAD(boundToHead!==true):PR 状态对的是
    // 另一个 commit,不能当本 worktree 当前 HEAD 的可信终态 → 不授予 removable(R1
    // CLA-R1-02/CV2-R1-002:boundToHead 此前被算出来却无人消费)。无关联 PR(row.pr=null)
    // 的正常已合入分支不受影响。
    if (row.pr && row.pr.boundToHead !== true) {
      return keep('clean merged (PR head 未绑定)', `查到关联 PR #${row.pr.number} 但其 head 未绑定当前 HEAD(boundToHead=${row.pr.boundToHead}),PR 终态不适用于本 worktree,fail-closed`);
    }
    return {
      classification: 'clean merged removable',
      removable: true,
      reasons: ['HEAD 已在基线、工作区干净、无在途 PR(或 PR 已绑定当前 HEAD)、无哨兵、全部探针完整'],
    };
  }
  // 分支不在基线:squash 合并后本地分支的 HEAD 不是基线祖先,靠 PR 终态提示人工确认。
  if (row.pr) {
    return keep(`PR ${row.pr.state.toLowerCase()}`, `关联 PR #${row.pr.number} 状态 ${row.pr.state},分支 HEAD 未在基线(如 squash 合并),人工确认`);
  }
  if (row.upstream === 'none' || (row.aheadOfUpstream ?? 0) > 0) {
    return keep('local unpushed feature', '本地未推送的功能分支(无 upstream 或领先 upstream),HEAD 不在基线,删了丢活');
  }
  // 措辞随 PR 通道状态变化:通道完整才敢说「无关联 PR」,否则只说未合入基线
  // (R2 CLA-R2-02:此前无条件断言「无关联 PR」,实测把 5 个持有 OPEN PR 的分支误报)。
  return keep('clean branch', row.prLookupOk
    ? '干净分支,未合入基线,查询确认无关联 PR'
    : '干净分支,未合入基线;是否有关联 PR 未知');
}
