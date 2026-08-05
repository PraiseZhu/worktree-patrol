#!/usr/bin/env node
// repo-worktrees — 只读巡检本仓全部 git worktree,按风险分类输出报告。
// 判定核心在 repo-worktrees-core.mjs(纯函数,fixture 单测覆盖);本文件只做探针
// 采集与渲染。移植自 cindy 仓同名脚本(6e8487a19)并加固,加固清单见 core 头注释。
//
// 只读承诺:仅调用 git 只读子命令与 gh pr list;git 一律带 GIT_OPTIONAL_LOCKS=0,
// 不产生任何写入(测试用 fake git 记录调用清单逐条断言)。
// 实际用到的 git 子命令(与 test 的 READONLY 白名单同源,改动时两处同步 —— R1
// U-493-03:此处曾声明从未调用的 symbolic-ref 又漏列实际调用的 log):
//   rev-parse / worktree list / status / rev-list / merge-base / log
// 探针定位隔离(R1 CV2-R1-001 + R2 CV2-R2-001 同族):外部环境变量能把 `git -C` 与
// `gh` 静默改指到另一个仓,使探针报出别人的状态却标 complete=true。故 git 侧清除
// 定位/配置类变量,gh 侧清除 GH_REPO 并显式传 --repo。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KEEP_SENTINEL,
  classify,
  parsePorcelainWorktrees,
  rankOf,
} from './repo-worktrees-core.mjs';

const HELP = `npm run repo:worktrees — 只读巡检本仓库全部 git worktree,按风险分类输出报告。

用法:
  npm run repo:worktrees [-- --base <ref>]          # 人读表格
  npm run -s repo:worktrees -- --json [--base <ref>] # 机读(必须带 -s:裸 npm run
                                                     # 会把 banner 打进 stdout 污染 JSON)

参数:
  --json         输出结构化 JSON(供 agent / 脚本消费;本脚本自身 stdout 只含 JSON)
  --base <ref>   合入判定基线,默认 origin/main
  --help         显示本说明

说明:本脚本纯只读、不删除任何东西。清理动作请按报告另行执行(cleanup-branch skill
会独立重验,不以本报告为授权)。

PR 状态来自 gh CLI(显式 --repo,不受 GH_REPO 影响),两类不完整分开表达:
  prLookup=degraded  —— 在途 PR 不可信(gh 不可用/超时/坏 JSON/坏行/open 查询被
                        --limit 截断/无法解析 origin 仓名)。此时"没有 active PR"
                        不可信,removable 一律 fail-closed 归零。
  historyTruncated   —— 仅历史 PR 终态(--state all)被 --limit 截断,属信息性字段
                        不全;不影响 removable(它只要求 HEAD 是基线祖先)。
                        本仓 PR 总数已长期 >200,故此标记是稳态常见值、不是故障。
`;

// gh 查询超时(毫秒)。定时任务场景 gh 卡死会拖垮整个巡检,必须有界;
// 测试通过环境变量注入更短值以覆盖超时路径。
const GH_TIMEOUT_MS = Number(process.env.REPO_WORKTREES_GH_TIMEOUT_MS || 10_000);
// gh pr list 的 --limit;返回条数达到它即视为截断(见 loadPrLookup)。
const GH_PR_LIMIT = 200;
// git 探针环境:清除 git 的定位类变量,否则外部注入的 GIT_DIR/GIT_WORK_TREE/
// GIT_INDEX_FILE/GIT_COMMON_DIR 会让 `git -C <path>` 静默串到另一个 checkout——
// 探针名义上在查 worktree A,实际读的是环境指定的 B,得出 A 的假状态(R1 席②实测)。
// 删掉它们后 `-C <path>` 是唯一的仓库定位来源。
export const GIT_ENV = (() => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) {
    delete env[k];
  }
  // GIT_CONFIG_* 的临时配置注入同样能改判定(R2 CLA-R2-04 实测:注入
  // status.showUntrackedFiles=no 可让真实 dirty 从 1 变 0)。计数式注入必须整组删。
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;
  for (const k of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  }
  return env;
})();
// gh 环境:清掉仓库定位变量,配合显式 --repo(见 resolveRepoSlug)。
// 保留 GH_TOKEN/GH_HOST 等认证类变量——它们决定「能不能查」,不决定「查哪个仓」。
export const GH_ENV = (() => {
  const env = { ...GIT_ENV };
  for (const k of ['GH_REPO', 'GITHUB_REPOSITORY']) delete env[k];
  return env;
})();

function die(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { json: false, base: 'origin/main', help: false };
  let baseSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) die('--base 缺少值(用法: --base <ref>)');
      if (baseSeen) die('--base 重复传入');
      baseSeen = true;
      opts.base = value;
      i++;
    } else if (arg.startsWith('--base=')) {
      die('不支持 --base=<ref> 形式,请用 --base <ref>');
    } else {
      die(`未知参数: ${arg}`);
    }
  }
  return opts;
}

export function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trimEnd();
}

export function tryGit(args, options = {}) {
  try {
    return git(args, { ...options, allowFailure: true });
  } catch {
    return null;
  }
}

// merge-base --is-ancestor 用退出码表达三态:0=是、1=否、其他=探针失败。
// execFileSync 无法区分 1 和 128,必须用 spawnSync 读原始 status。
function isAncestor(worktreePath, base) {
  const result = spawnSync('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', 'HEAD', base], {
    env: GIT_ENV,
    stdio: 'ignore',
  });
  if (result.status === 0) return { value: true };
  if (result.status === 1) return { value: false };
  return { error: `merge-base --is-ancestor 退出码 ${result.status ?? 'null'}` };
}

// .worktree-keep 哨兵不计入 dirty:哨兵机制要求「放了哨兵仍算干净」,否则
// 哨兵文件自身把 worktree 变 dirty,keep 与 clean 互斥,机制无法成立。
function countStatus(worktreePath) {
  const output = tryGit(['-C', worktreePath, 'status', '--porcelain=v1']);
  if (output === null) return { error: 'git status 失败' };
  const lines = output
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.slice(3) !== KEEP_SENTINEL);
  return {
    dirty: lines.length,
    untracked: lines.filter((line) => line.startsWith('??')).length,
    tracked: lines.filter((line) => !line.startsWith('??')).length,
  };
}

function aheadBehind(worktreePath, base) {
  const output = tryGit(['-C', worktreePath, 'rev-list', '--left-right', '--count', `${base}...HEAD`]);
  if (output === null) return { error: 'rev-list --left-right 失败' };
  const [behind, ahead] = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return { error: 'rev-list 输出不可解析' };
  return { behind, ahead };
}

// 从 origin 的 URL 解出 owner/repo。解不出即返回 null → PR 查询整体 degraded
// (不允许「不知道查的是哪个仓」还继续查,那正是 R2 CV2-R2-001 的形状)。
export function parseRepoSlug(remoteUrl) {
  if (!remoteUrl) return null;
  const m = String(remoteUrl).trim().match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function runGh(root, state, repoSlug) {
  return execFileSync(
    'gh',
    [
      'pr',
      'list',
      // 显式钉住目标仓:不靠 cwd 推断,也不受 GH_REPO 影响
      '--repo',
      repoSlug,
      '--state',
      state,
      '--limit',
      String(GH_PR_LIMIT),
      '--json',
      'headRefName,headRefOid,number,state,isDraft,title,url,isCrossRepository',
    ],
    { cwd: root, encoding: 'utf8', env: GH_ENV, timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

// PR 查询:成功返回 {status:'ok', map};任何失败返回 {status:'degraded', reason}。
// 消费方必须区分「确认没有 PR」与「没查成」——后者所有依赖 PR 的判定 fail-closed。
export function loadPrLookup(root, repoSlug) {
  // 不知道目标仓就不查:cwd 推断 + GH_REPO 继承会让 PR 数据来自另一个仓
  // (R2 CV2-R2-001 实测:数据来自 PraiseZhu/Review-PR 却仍报 removable=true)。
  if (!repoSlug) {
    return { status: 'degraded', reason: 'repo-slug-unresolved', map: new Map(), historyTruncated: false };
  }
  let openRaw;
  let allRaw;
  try {
    openRaw = runGh(root, 'open', repoSlug);
    allRaw = runGh(root, 'all', repoSlug);
  } catch (error) {
    const reason =
      error?.code === 'ENOENT'
        ? 'gh-unavailable'
        : error?.killed || /ETIMEDOUT/.test(String(error?.code ?? ''))
          ? 'gh-timeout'
          : 'gh-error';
    return { status: 'degraded', reason, map: new Map() };
  }
  let openRows;
  let allRows;
  try {
    openRows = JSON.parse(openRaw);
    allRows = JSON.parse(allRaw);
    if (!Array.isArray(openRows) || !Array.isArray(allRows)) throw new Error('not array');
  } catch {
    return { status: 'degraded', reason: 'gh-bad-json', map: new Map() };
  }
  // 截断检测**按查询用途分离**(R2 CLA-R2-01/CV2-R2-002):
  //  - open 查询截断 → 在途 PR 可能漏掉 → 整体 degraded、fail-closed(removable 归零)。
  //    这是唯一支撑「无在途 PR」的查询,漏了就不能授予删除。
  //  - all 查询截断 → 只影响历史 PR 终态这类**信息性**字段,不参与 removable 判定
  //    (removable 要求 HEAD 是基线祖先,此时提交全可从基线到达,删除不丢内容),
  //    故仅标 historyTruncated,不整体 degraded。
  //    此前一律 degraded 的写法让本仓(--state all 稳态 >200)永久失效:实跑 69 行
  //    complete=true 0 条、removable 0 条——工具在稳态下形同报废。
  if (openRows.length >= GH_PR_LIMIT) {
    return { status: 'degraded', reason: 'gh-open-truncated', map: new Map(), historyTruncated: false };
  }
  const historyTruncated = allRows.length >= GH_PR_LIMIT;
  // 行内字段完整性:只有外层 Array 校验不够——「查到了行但字段不可信」若漏进 classify,
  // 缺失 state 会绕过 state==='OPEN' 判定落进唯一的 removable 分类(R1 CLA-R1-02)。
  // 任一行缺必需字段即整批 degraded,不做「坏一行留其余」的部分信任。
  const rowValid = (r) => r && typeof r.headRefName === 'string'
    && typeof r.number === 'number'
    && typeof r.state === 'string'
    && typeof r.isCrossRepository === 'boolean';
  if (![...openRows, ...allRows].every(rowValid)) {
    return { status: 'degraded', reason: 'gh-bad-row', map: new Map(), historyTruncated: false };
  }
  const map = new Map();
  // 在途 PR 的两个索引(建账策略消费):
  //  - openHeadRefNames 排除 cross-repo(fork 的分支名在对方仓,与本地分支不对应);
  //  - openHeadOids **包含** cross-repo(OID 是全仓对象空间,本地 detached checkout
  //    到 fork PR 的 head 时必须能命中,否则在审 PR 被误判无关联)。
  const openHeadRefNames = [];
  const openHeadOids = [];
  const consider = (row) => {
    // fork PR 的 headRefName 是对方仓库里的分支名,与本地分支不对应,入表会误关联。
    if (row.isCrossRepository) return;
    const prev = map.get(row.headRefName);
    if (!prev) {
      map.set(row.headRefName, row);
      return;
    }
    // 同名分支删旧建新会出现多条 PR:OPEN 优先,其次 number 取大。
    const openDelta = Number(row.state === 'OPEN') - Number(prev.state === 'OPEN');
    if (openDelta > 0 || (openDelta === 0 && row.number > prev.number)) {
      map.set(row.headRefName, row);
    }
  };
  // open 单独拉一遍先入表:--state all 的 limit 作用在全历史,PR 总数超 limit 时
  // 老而仍 open 的 PR 会被挤出;open 专查保证在途 PR 不丢。
  for (const row of openRows) {
    consider(row);
    if (!row.isCrossRepository) openHeadRefNames.push(row.headRefName);
    if (typeof row.headRefOid === 'string' && row.headRefOid) openHeadOids.push(row.headRefOid);
  }
  for (const row of allRows) consider(row);
  return { status: 'ok', reason: null, map, historyTruncated, openHeadRefNames, openHeadOids };
}

function buildRow(entry, base, prLookup) {
  const probeErrors = [];
  const row = {
    path: entry.path,
    head: entry.head,
    branch: null,
    detached: entry.detached,
    locked: entry.locked,
    lockedReason: entry.lockedReason,
    prunable: entry.prunable,
    prunableReason: entry.prunableReason,
    missing: false,
    hasKeep: false,
    // 未测量用 null,不用 0 冒充「已测量且干净」(R1 CLA-R1-01:prunable/missing 行
    // 在探针前就 return,若初值 0 会被读成「测过、干净」)。countStatus 成功才覆盖为数字。
    dirty: null,
    tracked: null,
    untracked: null,
    upstream: null,
    aheadOfUpstream: null,
    inBase: null,
    ahead: null,
    behind: null,
    subject: null,
    pr: null,
    prLookupOk: prLookup.status === 'ok',
    probeErrors,
  };

  row.branch = entry.detached ? 'DETACHED' : (entry.branchRef ?? '').replace(/^refs\/heads\//, '') || null;

  // prunable:porcelain 已裁定注册项待 prune,目录不在了,探针全部跳过。
  if (entry.prunable) {
    return finalizeRow(row, prLookup);
  }
  if (!entry.path || !existsSync(entry.path)) {
    row.missing = true;
    return finalizeRow(row, prLookup);
  }

  row.hasKeep = existsSync(join(entry.path, KEEP_SENTINEL));

  const status = countStatus(entry.path);
  if (status.error) probeErrors.push(status.error);
  else Object.assign(row, status);

  if (!entry.detached) {
    row.upstream = tryGit(['-C', entry.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ?? 'none';
    if (row.upstream !== 'none') {
      const aheadRaw = tryGit(['-C', entry.path, 'rev-list', '--count', '@{u}..HEAD']);
      if (aheadRaw === null) probeErrors.push('rev-list @{u}..HEAD 失败');
      else row.aheadOfUpstream = Number.parseInt(aheadRaw, 10) || 0;
    }
  }

  const ancestor = isAncestor(entry.path, base);
  if (ancestor.error) probeErrors.push(ancestor.error);
  else row.inBase = ancestor.value;

  const counts = aheadBehind(entry.path, base);
  if (counts.error) probeErrors.push(counts.error);
  else Object.assign(row, counts);

  row.subject = tryGit(['-C', entry.path, 'log', '-1', '--format=%s']) ?? null;

  return finalizeRow(row, prLookup);
}

function finalizeRow(row, prLookup) {
  if (row.branch && row.branch !== 'DETACHED') {
    const pr = prLookup.map.get(row.branch);
    if (pr) {
      row.pr = {
        number: pr.number,
        state: pr.state,
        isDraft: pr.isDraft,
        url: pr.url,
        headRefOid: pr.headRefOid ?? null,
        // PR 查到的 head 与本地 HEAD 是否同一 commit:false 意味着"查到同名分支的
        // PR"不等于"确认了当前 HEAD 的 PR 状态",消费方据此降低置信。
        boundToHead: pr.headRefOid ? pr.headRefOid === row.head : null,
      };
    }
  }
  const verdict = classify(row);
  row.classification = verdict.classification;
  row.removable = verdict.removable;
  row.reasons = verdict.reasons;
  // complete = 本行全部探针成功 且 PR 查询通道完整 且 不是零探针行。false 时本行不可作
  // 删除依据。prunable/missing 行在探针前就 return(零探针),必须与 missing 同样判不完整
  // ——否则 complete 空转为 true,与「本行全部探针成功」的自述契约矛盾(R1 CLA-R1-01)。
  row.complete = row.probeErrors.length === 0 && row.prLookupOk && !row.missing && !row.prunable;
  return row;
}

function formatPr(pr) {
  if (!pr) return '-';
  const draft = pr.isDraft ? ' draft' : '';
  const bound = pr.boundToHead === false ? ' head≠' : '';
  return `#${pr.number} ${pr.state}${draft}${bound}`;
}

function flagsOf(row) {
  const flags = [];
  if (row.locked) flags.push('locked');
  if (row.prunable) flags.push('prunable');
  if (row.missing) flags.push('missing');
  if (row.hasKeep) flags.push('keep');
  if (!row.complete) flags.push('incomplete');
  return flags.join(',') || '-';
}

function pad(value, width) {
  const string = String(value);
  return string.length >= width ? string : string + ' '.repeat(width - string.length);
}

function printTable(rows, meta) {
  console.log(`Base: ${meta.base}  Repo: ${meta.repoSlug ?? '(未解析)'}`);
  if (meta.prLookup.status !== 'ok') {
    console.log(`警告: PR 查询不完整(${meta.prLookup.reason})——"无 active PR"不可信,removable 判定已全部 fail-closed`);
  } else if (meta.prLookup.historyTruncated) {
    console.log(`提示: 历史 PR 查询达 --limit ${GH_PR_LIMIT} 被截断,已合并/关闭 PR 的终态展示可能不全;removable 判定不依赖它,不受影响`);
  }
  console.log('dirty is total/untracked(-/- = 未测量)');
  const columns = [
    ['class', 30],
    ['dirty', 7],
    ['branch', 40],
    ['base', 12],
    ['ahead/behind', 13],
    ['pr', 18],
    ['flags', 18],
    ['path', 0],
  ];
  console.log(columns.map(([name, width]) => (width ? pad(name, width) : name)).join('  '));
  console.log(columns.map(([, width]) => (width ? '-'.repeat(width) : '----')).join('  '));
  for (const row of rows) {
    const values = {
      class: row.classification,
      // 未测量渲染成 -/-,不渲染 null/null(R2 CLA-R2-05)
      dirty: row.dirty === null ? '-/-' : `${row.dirty}/${row.untracked}`,
      branch: row.branch ?? '-',
      base: row.inBase === null ? '?' : row.inBase ? 'in-base' : 'not-base',
      'ahead/behind': `${row.ahead ?? '?'}/${row.behind ?? '?'}`,
      pr: formatPr(row.pr),
      flags: flagsOf(row),
      path: row.path,
    };
    console.log(columns.map(([name, width]) => (width ? pad(values[name], width) : values[name])).join('  '));
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const root = git(['rev-parse', '--show-toplevel']);
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });

  // 基线解析不了时所有 in-base / ahead/behind 判定会集体静默失真,必须硬失败。
  const baseCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`], {
    cwd: root,
    env: GIT_ENV,
    stdio: 'ignore',
  });
  if (baseCheck.status !== 0) {
    die(`基线 "${opts.base}" 无法解析为 commit。origin/* 基线请先 git fetch origin;自定义 --base 请检查拼写。`);
  }

  const repoSlug = parseRepoSlug(tryGit(['-C', root, 'remote', 'get-url', 'origin']));
  const prLookup = loadPrLookup(root, repoSlug);
  const entries = parsePorcelainWorktrees(git(['worktree', 'list', '--porcelain'], { cwd: root }));
  const rows = entries.map((entry) => buildRow(entry, opts.base, prLookup));
  rows.sort((a, b) => rankOf(a.classification) - rankOf(b.classification) || a.path.localeCompare(b.path));

  const meta = {
    generatedAt: new Date().toISOString(),
    host: hostname(),
    root,
    commonDir,
    base: opts.base,
    repoSlug,
    baseLookup: { status: 'ok' },
    prLookup: {
      status: prLookup.status,
      reason: prLookup.reason,
      // 历史 PR(--state all)被截断:信息性字段不全,不影响 removable
      historyTruncated: prLookup.historyTruncated === true,
    },
  };

  if (opts.json) {
    // --json 契约:stdout 只含 JSON,一切人读信息走 stderr。
    if (prLookup.status !== 'ok') {
      console.error(`警告: PR 查询不完整(${prLookup.reason}),removable 判定已 fail-closed`);
    } else if (prLookup.historyTruncated) {
      console.error(`提示: 历史 PR 查询被截断(historyTruncated),PR 终态展示可能不全;removable 不受影响`);
    }
    process.stdout.write(`${JSON.stringify({ ...meta, rows }, null, 2)}\n`);
    return;
  }
  printTable(rows, meta);
}

// 只在被直接执行时跑 CLI:被 import(测试复用 parseRepoSlug 等纯函数)时不得
// 触发整套探针与 stdout 输出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
