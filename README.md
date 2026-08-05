# worktree-patrol

**本机 git worktree 自动建账 + 自动清理。** 个人机器卫生工具——独立成仓,不寄居在被治理的项目仓里。

## 它解决什么

多 agent 并行开发(Orca 派工、create-pr、review 轮)持续产出 git worktree,积累到几十个后没人记得哪个能删。本工具把 cindy 桌面端的治理思路移植到"无主历史存量":**没有台账就机器建账;有账且可证零损失就自动清;建不了账的分毫不动。**

实测(2026-08-05 首轮实机):69 个注册项 → 自动清 40(每项恢复演练全等通过)、按证据保留 29、误删 0。

## 三条硬原则

1. **存证优先于判断**:不猜"删了有没有损失",先把每项变成"删了零损失"再删(cindy 模式)。脏内容 stash 成快照 ref、未推送提交打 immutable 归档 ref + bundle、ignored 残渣独立归档,全部复验通过才允许删除层碰它。
2. **硬保留门独立求 OR**:主仓根(按仓身份非分支名)/`.worktree-keep` 哨兵/locked/在途 PR(分支名或 detached HEAD OID 双通道)/lsof 观察到进程占用/近 T 小时(默认 48h)内有活动且带损失内容——任一命中即保留,收集全部理由不短路。
3. **fail-closed**:任一探针失败、gh 通道不完整、config 非法、身份漂移 → 一律不删。「不知道」永远不等于「可以删」。

## 组件

| 脚本 | 职责 |
|---|---|
| `scripts/ledger-bootstrap.mjs`(+`ledger-core.mjs`) | 建账器:冻结 cohort(porcelain 原文+hash+run_id)→ 逐项探针(身份/损失清单/活动时间/PR/哨兵)→ 判决式台账(`state/ledger.json`,O_EXCL 锁 + 原子写,幂等) |
| `scripts/preserve.mjs` | 存证与恢复原语(**永不删除**):归档 ref(expected-old=zero 不可覆盖)/bundle(verify+list-heads+隔离空仓 fetch 复验)/stash 快照(唯一 marker,失败 apply --index 回滚)/残渣 tar(-n 显式清单含空目录,解包逐 hash 复验)。产出一次写入的 receipt + 结构化 recoveryArgv。`rehearse` 子命令按 recoveryArgv 实际恢复并逐字段全等校验 |
| `scripts/reclaim.mjs` | 删除器:只消费「schema-valid + config/source hash 匹配 + receipt 复读逐 artifact 重验」的项;身份重验×2 + 末刻重验(HEAD/status/哨兵/locked/PR/lsof);durable removing intent 先落账;唯一破坏动作 `git worktree remove` **无 --force**;四象限处置;分支永不删 |
| `scripts/worktree-patrol.mjs` | 调度链:`hook`(纯只读判定,零写)→ `report`(建账→存证→回收→post-reclaim 复采→写 pending+通知文本)→ `ack`(绑定 run_id+registry hash+台账 hash,漂移即拒) |
| `scripts/repo-worktrees.mjs`(+core) | 只读巡检器(16 分类风险报告,独立可用):`npm run repo:worktrees` |

## 每天 06:00 发生什么

```
hook(零 token 判定) ── 无变化且无到期项 → exit 2,直接睡
   │ pending 未确认 / 首轮 / source|config 指纹变化 / registry 变化 / 48h 保护窗到期
   ▼
report:建账 → 存证(全部复验) → 回收(重验×3) → 复采 → 通知四分区
   已清 N(恢复台账路径) / 保留 M(逐条理由) / 建不了账 K(探针原因) / 失败·漂移·冲突 F
   │ F>0 或通知失败 → 不 ack,pending 保留,次轮必重报
   ▼
ack:registry/台账 hash 仍与 run 结束时一致才晋升基线
```

## 恢复(每个已清项都有可粘贴命令)

receipt 在 `state/receipts/<entryId>.json`,含 `recoveryText`:
```
DEST=<目标目录>; git -C <repo> worktree add --detach "$DEST" <head> && git -C "$DEST" stash apply --index <sha> && tar -x -f <residue.tar> -C "$DEST"
```
首轮实机 40/40 按此演练恢复,与删除前逐字段(类型/mode/size/sha256/软链目标/index 状态)全等。

## 明确不做

- **不删分支、不 prune、不 unlock、无远端写**(分支清理走 cleanup-branch 人工路径)
- 嵌套 git 仓 / 脏 submodule:v1 无等价归档 → unledgerable,零动作
- 目录已消失的注册残根:v1 零 prune,只报告

## 配置

`config/patrol.config.json`:`thresholdHours`(默认 48,0 合法)/`allowedRoots`(白名单外零授权)/`residueMaxBytes`/`lsofBin`/`lsofTimeoutMs`。config 非法 → 整轮拒绝 reclaim。

## 测试

```bash
npm install && npm test   # 104 用例
```
覆盖:分类矩阵与策略矩阵(含反向变异/组合门/边界 T)、真 fixture 仓 E2E(零写 argv 级断言、幂等、并发锁、gh 仓级故障、真 lsof 真进程、deferred-next-run)、存证全形态演练全等 + 五路故障注入回滚、删除器三窗口 TOCTOU/四象限/崩溃收敛/hostile env/台账伪造拒绝、调度链四分区/ack 绑定/指纹触发。

## 共识记录

方案经 gpt-5.6-sol 对抗审核达成共识(2026-08-05,AMEND 全盘采用 + 阈值 48h、lsof 三态两参数 ACK),SC 全文见 `~/.claude/.goal/worktree-patrol-autoclean.md`。与 ACK 文本的唯一实测偏差已注记于 `live-probe.mjs`(真实 lsof 的 exit 1+p 记录 = observed-live,方向只更保守)。
