# worktree-patrol

**本机 git worktree 风险巡检与治理。** 个人机器卫生工具——不是任何项目的代码，因此独立成仓、不寄居在被巡检的项目仓里。

## 它解决什么

多 agent 并行开发（Orca 派工、create-pr、review 轮）会持续产出 git worktree。积累到几十个之后：哪个还有用、哪个能删、哪个删了会丢未提交的活，全靠人肉记。本工具把这件事变成一条命令 + 一个每日定时播报。

实测规模：单台机器 68 个注册 worktree，其中含 1 个 detached 且有未提交改动（删了永久丢失）、36 个有本地未推送提交。

## 两个组件

| 组件 | 作用 |
|---|---|
| `scripts/repo-worktrees.mjs`(+`-core.mjs`) | 只读巡检器：把每个 worktree 按风险分成 16 类，输出人读表格或 `--json` |
| `scripts/worktree-patrol.mjs` | 定时调度侧 wrapper：`hook`/`report`/`ack` 三子命令，配合 Cindy scheduler 做「有变化才提醒」 |

## 用法

```bash
npm run repo:worktrees                      # 人读表格
npm run -s repo:worktrees -- --json         # 机读(必须带 -s,否则 npm banner 污染 stdout)
npm run repo:worktrees -- --base <ref>      # 换合入判定基线(默认 origin/main)
```

被巡检的目标仓默认是 `Project MivoCanvas`，用 `WORKTREE_PATROL_TARGET_REPO=/path/to/repo` 覆盖。

## 分类与唯一的删除信号

16 个固定分类按风险排序（另有动态 `PR <state>` 族）。**`removable: true` 是唯一允许自动化删除流程消费的信号**，要求全部成立：HEAD 是基线祖先 + 工作区干净 + 无在途 PR + 无 `.worktree-keep` 哨兵 + 未 locked + 全部探针成功 + PR 查询通道完整。

其余一律 `false`，包括这些容易被误当"可删"的：

- `detached dirty danger` —— 最危险：无分支且有未提交改动
- `local unpushed feature` —— 有未 push 的提交，删了丢活
- `clean merged (unverified PR)` / `clean merged (PR head 未绑定)` —— PR 通道不完整或 PR head 与本地 HEAD 不匹配，不敢授权
- `keep sentinel` —— 人工放了 `.worktree-keep`，任何模式都不穿透
- `prunable (path gone)` / `missing (unknown state)` —— 目录已消失，处置动作是 `git worktree prune` 而非分支清理

**本工具只出报告，永不删任何东西。** 清理走 `cleanup-branch` skill 的 guard（独立重验 + TOCTOU），不以本报告为授权。

## fail-closed 设计

宁可少报可删项，不可误授权删除。两类不完整分开表达，不混为一谈：

- `prLookup.status=degraded` —— 在途 PR 不可信（gh 不可用/超时/坏 JSON/坏行/**open 查询被 limit 截断**/无法解析 origin 仓名）。此时 `removable` 全部归零。
- `prLookup.historyTruncated=true` —— 仅历史 PR 终态（`--state all`）被 limit 截断，属信息性字段不全，**不影响 `removable`**。PR 总数超 200 的仓这是稳态常见值，不是故障。

探针定位隔离：`git` 侧清除 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_CONFIG_*` 等定位与配置变量，`gh` 侧清除 `GH_REPO` 并显式传 `--repo`（从 origin URL 解析）。否则外部环境变量能把探针静默改指到另一个仓，报出别人的状态却标 `complete=true`。

只读承诺：只调 `rev-parse`/`worktree list`/`status`/`rev-list`/`merge-base`/`log`/`remote get-url` 与 `gh pr list`，全程 `GIT_OPTIONAL_LOCKS=0`。测试用 fake git 逐条断言调用清单，并比对运行前后仓库状态全等。

## 定时巡检

`worktree-patrol.mjs` 配合 Cindy scheduler（每日 06:00 Asia/Shanghai）：

- `hook`（preRunHook）：纯只读判定要不要跑。`exit 2` = 与已确认基线一致 → 跳过、零 token 不起 agent；`exit 0` = 有新情况 → 起 agent；`exit 1` = 采集失败 → run failed 可见。**hook 永不写文件**，所以 scheduler 的 self-test 天然零副作用。
- `report`：重新采集、打印聚合摘要（不倾倒全部绝对路径）、原子写 pending。
- `ack --pending <id>`：通知**成功送达后**才把 pending 晋升为基线。没送成就不 ack，下轮继续报。

只报"新坏状态"：新增高危、风险升级、脏度上升、新增可删/prunable、受保护项意外消失。同一个已确认状态不重复刷屏。

## 测试

```bash
npm install && npm test
```

41 个用例：纯函数分类矩阵（含 fail-closed 全场景与反向变异）+ 真实 fixture 仓端到端（集合全等、零写断言、gh 五种降级态、参数 fail-closed、env 劫持防护）。
