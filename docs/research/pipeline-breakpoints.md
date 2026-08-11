# 全链路断点排查：消息进入 → 结果反馈（issue #58）

> 研究票：issue #58（地图 issue #53 子票）。基于 master `33944a8f` 的源码走查。
> 范围：消息进入（publish / @mention / 回复）→ 路由 → WU 创建 → 认领 → 执行 → 结果回写与频道反馈 → 超时与失败处理 → 恢复。
>
> **已在专票跟踪、本文不重复报告的 4 个断点**：
> ① `agent-loop.ts:703` 每步 120s 硬超时；② 失败中间步骤不发频道消息（`agent-loop.ts:742-763`）；③ 认领无 acceptedTypes 门槛（`agent-loop.ts:435`）；④ consecutiveStuck blocked 后无自动恢复。

## 断点总览

| # | 环节 | 断点 | 严重度 |
|---|------|------|--------|
| H1 | 超时处理 | WU timeoutAt 只在 claim 时写一次、跨 step 不刷新 → 长任务执行中被释放回池，双 agent 并发执行同一 WU | 高 |
| H2 | FileStore 可靠性 | workunits mkdir 锁无 stale 回收，持锁进程被杀 → 全链路永久停摆且无告警 | 高 |
| M1 | 结果回写 | recordResult 读-改-写跨秒级窗口，与并发写方互相覆盖（last-write-wins） | 中 |
| M2 | 评审派发 | ReviewDispatcher 路径 A 失败后无重试/无对账，父 WU 永卡 in_review | 中 |
| M3 | 评审派发 | 双实例下 review 子 WU 建单 check-then-create 竞态，可重复建单 | 中 |
| M4 | 恢复 | 优雅关闭不等在飞 step、不杀 CLI 子进程；孤儿 WU 只能等超时释放（默认 60min+） | 中 |
| M5 | FileStore 可靠性 | appendEvent 与 upsertSnapshot 非原子 + rebuildIndex 零生产调用 → events/index 分叉无对账 | 中 |
| M6 | FileStore 可靠性 | index.json 损坏 → 所有 loop/扫描 15s 空转，仅日志无告警 | 中 |
| M7 | 执行 | checkSessionTruncation / extractInputTokens 解析纯文本 outputText，100K 截断与 cache 追踪形同虚设 | 中 |
| M8 | 消息进入 | PMO publish 四步无事务，中途失败留不一致，重试产生重复 WU | 中 |
| M9 | 认领 | observe myActive 窗口截断（20 条）：实例历史 WU 积压后老 active WU 掉出视野 | 中 |
| M10 | 超时处理 | agent-timeout-scan 可误杀活实例（心跳写失败静默）→ 在飞 WU 被 blocked，活 loop 却拦不住 | 中 |
| L1 | 认领 | workunit.created EVENT 触发器空转：handler 只调 observe() 丢弃结果，拾取全靠 15s 轮询 | 低 |
| L2 | 路由 | routeMessage 先建 WU 后发频道消息，消息写失败留孤儿 WU | 低 |
| L3 | 路由 | @mention 未匹配任何 profile 时静默转涌现认领，频道无提示 | 低 |
| L4 | 超时处理 | timeout-release unclaim 清空 assigneeId，@ 指名语义丢失 | 低 |
| L5 | 认领 | claim 的文件冲突检查在锁外，存在并发窗口 | 低 |
| L6 | 频道反馈 | 新鲜度检查基于行数，消息更新/墓碑行推高 lineCount → 假性发言拦截 | 低 |
| L7 | 频道反馈 | postWuSystemMessage anchor 查找失败静默降级为根消息，脱离线程 | 低 |
| L8 | 恢复 | updateState 无锁读-改-写，心跳与 terminate 并发互相覆盖 | 低 |

---

## 1. 消息进入与路由

### M8 — PMO publish 非原子（中）

`apps/api/src/modules/pmo/project.service.ts:430-468`：publish 依次执行 `createHumanMessage` → `updateMessageMeta` → `workUnitService.create` → `updateStatus('active')`，四步无事务、无补偿：

- WU 创建失败 → 频道消息已发但没有 WU，用户以为已派工；
- `updateStatus` 失败 → WU 已建但项目仍是 `pending`，用户重试 publish 会通过 `:433` 的状态校验，**重复建 WU**；
- 该链路不走 `routeMessage`，无 traceId（`message-routing.ts:165` 的 P0 修复 6 只覆盖 @mention 路径），publish 链路的日志无法串联。

### L2 — routeMessage 先建 WU 后发消息（低）

`message-routing.ts:149-199`：`wuService.create` 在前、`createHumanMessage` 在后。消息追加失败（磁盘/权限）时 WU 已成孤儿：agent 照常认领执行，回帖时 `findAnchorMessage`（`wu-messenger.ts:41-50`）找不到线程锚点，回复全部脱线程；用户在频道里从未见过自己那条消息。回复路径（`:69-91`）顺序相反，无此问题。

### L3 — @mention 未匹配静默转涌现（低）

`message-routing.ts:96-118`：`detectMention` 只取第一个 @；名字不匹配任何 active 且在本频道 members 内的 profile 时 `agent=null`，WU 以 `assigneeId=null` 创建走涌现认领。`metadata.matched=false` 有落档，但频道无任何「没匹配到 @xxx，已转公共池」提示——用户以为指名成功，实际任何成员都可能认领（对比 @studio 改派有系统消息，`:201-212`）。

## 2. 认领

### L1 — workunit.created EVENT 触发器空转（低）

`agent-loop.ts:210-216`：EVENT handler 只调用 `this.observe()` 并丢弃返回值，不做 `resolveTarget`/`claim`——事件驱动的快速认领实际上不存在，真实拾取全靠 `runLoop` 的 15s 轮询（`:293`）。后果：认领延迟 0–15s（可接受但与设计意图不符），且 trigger 日志显示 "fired" 具有误导性，排障时会误判事件链路正常。

### M9 — observe myActive 窗口截断（中）

`agent-loop.ts:422-426`：`mine.sort(createdAt desc).slice(0, 20)` **先截断再过滤** active/blocked。实例认领数是单调累积的（done/closed WU 的 assigneeId 仍是该 instance.id，不会被清），长期运行的实例历史 WU 超过 20 条后，较老的 active WU 永久掉出观察窗口：不再被 step、新回复（`newReplies` 只查 myActive，`:464-473`）也不再注入。唯一兜底是 timeoutAt 到期被释放回池（见 H1，释放本身另有并发风险）。`unassigned` 侧 `slice(0, 5)`（`:453`）同理，积压时每个 loop 周期只拾取 5 条。

### L5 — claim 文件冲突检查在锁外（低）

`workunit-crud.ts:414-425`：`checkFileConflicts`（两次 `getIndex` 读）在 `fileStore.claimWorkUnit` 的 mkdir 锁之外，检查与认领之间有窗口：两个 metadata.files 重叠的 WU 可被两个 loop 同时认领成功。当前 `metadata.files` 写入面小，故评低；若未来依赖文件级互斥，需要把冲突检查移入锁内。

### L4 — timeout-release 丢 mention 指向（低）

`timeout-release.ts:60` 调 `unclaim`（`workunit-crud.ts:452-464`）把 `assigneeId` 清空。原本 @ 指名给 profile X 的 WU 超时回池后变成全员可见（`agent-loop.ts:436-447` 的指名过滤只对 `assigneeId` 非空生效），任何频道成员可认领——指名语义在一次超时后永久丢失。

## 3. 执行

### M7 — 会话截断与 token 追踪是死代码（中）

`agent-loop.ts:829` 的 `checkSessionTruncation(result.outputText, …)` 与 `:855` 的 `extractInputTokens(result.outputText ?? '')` 都逐行 JSON.parse 找 stream-json 事件，但 `outputText` 是 `extractResult` 后的纯文本（`runner-lightweight.ts:167`，stream-json 原文在 `rawOutput`，`:168`）——本文件 `:785-786` 的 R2-fix 注释已承认这一点，tool:call 提取改用了 rawOutput，但这两处没有同步。后果：

- 100K `SESSION_TOKEN_LIMIT` 截断（`:1006-1011`）**永不触发**，超长会话不会被重置，直到撞上 B5 会话上限或 CLI 自己报错；
- `metadata.lastInputTokens` 永不落档，AC-4.3/4.4 的 cache 追踪数据缺失。

### H1 — WU timeoutAt 不刷新 → 执行中被释放、双 agent 并发（高）

`workunit-crud.ts:439-443`：`timeoutAt` 只在 claim 时写一次（task 60min / review 30min），跨 step 从不刷新，也没有「WU 维度的活跃心跳」。`timeout-release.ts:28` 的扫描只看 `timeoutAt ≤ now`，不看 `updatedAt`/step 活动。但一个 WU 的总执行时长 = 多步累计（review WU 上限 30 步 × (120s 执行 + 间隔） ≈ 61min > 其 30min 超时；task 15 步 ≈ 31min，叠加 prompt 组装与守卫可超 60min）。于是：

1. WU 正在被执行（agentStep 进行中）时被扫描命中 → `unclaim` → status=unassigned、assigneeId 清空；
2. 任何频道成员的 loop 下一轮即可认领同一个 WU，与原 loop 的在飞 step **并发执行**——同一 worktree 两个 CLI 会话同时写、频道双倍回帖、recordResult 双方互写 metadata；
3. 原 loop step 完成后 `recordResult` 面对 unassigned/他人 active 的状态做迁移：`unassigned → in_review` 不在 VALID_TRANSITIONS（`workunit.types.ts:194-201`），抛错仅由 runLoop 兜底记日志（`agent-loop.ts:323-327`），本步结果（含 token 簿记）丢失。

修复方向：每次 recordResult 顺手顺延 timeoutAt（或扫描时要求 `updatedAt` 也超阈），释放前确认无在飞执行。

## 4. 结果回写与频道反馈

### M1 — recordResult 读-改-写竞态（中）

`agent-loop.ts:1027` 读 WU → 守卫/验证/发消息（秒级）→ `:1166` 用「读时快照 + 本步增量」整体覆盖 metadata。该窗口内的并发写全部丢失（last-write-wins）：

- 人类回复触发的 `resumeWaitingWorkUnit`（`waiting-input.ts:64-74` 写 pendingReplies + 状态迁移）→ 回复丢失、永不被注入 prompt；
- `scanTimedOutWorkUnits` / `scanWaitingForInputReminders` 的 metadata 写（timeoutReleaseCount、waitingReminded）→ 被陈旧值回写，提醒可重复发送、释放计数回退。

upsertSnapshot 的 flock（`file-store-workunit.ts:141-143`）只保证写文件不错乱，管不了应用层的读-改-写丢失。

### L6 — 新鲜度检查把消息更新/墓碑当新发言（低）

`file-store.ts:485-511`：频道版本 = messages.jsonl 原始行数。`updateMessageMeta`/`updateMessage`（`channel-message.service.ts:146-203`）和 `softDeleteMessage`（`file-store.ts:571-581`）都以追加行实现，同样推高 lineCount → `agent-loop.ts:1075-1086` 把「有人改了 meta/删了消息」当外部新发言，结果帖被拦截降级为 progress 并把更新行内容注入 pendingReplies（重复注入旧文）。有 2 次拦截上限兜底，不会卡死，但会延迟结果反馈并污染上下文。

### L7 — 回帖 anchor 失败静默脱线程（低）

`wu-messenger.ts:83`：anchor 查询失败 `.catch(() => null)` 后照常发帖，消息变成无线程根消息。频道静默可读但线程结构破坏，无任何日志。配合 L2（孤儿 WU 无 anchor）影响放大。

## 5. 超时与失败处理

### M10 — agent-timeout-scan 可误杀活实例（中）

`index.ts:225-240`：扫描把 `lastHeartbeat` 过期（5min）或为 null 的实例交给 `AgentInstanceService.terminate`，后者把其在飞 WU `blockForManualRelease` 置 blocked（`agent-instance.service.ts:90-95`）。但：

- loop 侧所有心跳/状态写都是 `.catch(() => {})` 静默（`agent-loop.ts:311-315`、`347`）：FileStore 写故障（磁盘满、H2 的锁超时等）持续 5min，**活着的 loop** 实例就会被 terminate，其在飞 WU 被置 blocked 转人工；
- 而 terminate 只改文件状态，拦不住内存里的活 loop——myActive 过滤包含 blocked（`agent-loop.ts:426`），loop 会继续对该 WU step。监控显示已终止、WU 显示 blocked 待人工，实际 agent 还在跑还在发帖，人与系统双轨。

### M2 — 评审派发失败无重试、无对账（中）

`review-dispatcher.ts:43-53`：路径 A 完全依赖进程内 eventBus 的一次性投递，`handleParentInReview` 失败仅记日志。建单失败（FileStore 抖动等）后父 WU 永卡 in_review——没有任何周期扫描兜底，唯一出口是人工调 `POST /:id/dispatch-review`（`:152-174` 的 F6-c 补票口）。analysis-handoff 同为 eventBus 订阅模式（`index.ts:199-203`），同类风险。

### M3 — 双实例下 review 子 WU 可重复建单（中）

`review-dispatcher.ts:100-108` 的同父唯一性哨兵是「读 index 检查有无未完结 review 子 WU」，与 `workUnitService.create` 之间无互斥、index 也无 (parentId, type) 唯一约束。dev/prod 双实例共享 `~/.studio` 时两侧都订阅 eventBus（`index.ts:186-190` 注释明确两侧都保留订阅），同一 status_changed 在两个进程几乎同时处理 → 各自通过哨兵 → **重复建 review 子 WU**，两名 reviewer 并行评审、结论互相覆盖（后到的 `reviewPassed/reviewRejected` 对已迁移的父 WU 抛错或误补台账）。

## 6. 恢复 / 重启 / 部署

### H2 — workunits mkdir 锁无 stale 回收（高）

`file-store-base.ts:125-148`：withLock 用 mkdir 目录做跨进程互斥，`finally` 里 rmdir。进程在持锁期间被 SIGKILL（部署脚本 kill -9、OOM killer、断电）时 finally 不执行，`workunits/lock` 目录永存——此后**所有** claim / upsertSnapshot / update / timeout-release 全部在 5s 后抛 LockTimeoutError：新 WU 创建失败、认领失败、recordResult 失败（runLoop 记日志后 15s 空转）。整个编排层停摆，唯一信号是日志刷屏，无告警、无自愈（锁目录无创建时间探测、无 TTL）。建议：锁目录带 mtime 老化回收（如 >60s 视为 stale）或锁内写 holder 信息 + 启动时清理。

### M5 — events/index 非原子 + rebuildIndex 零生产调用（中）

`workunit-crud.ts:203-206`、`326-335` 等处都是先 `appendEvent` 再 `upsertSnapshot`，两步跨锁（appendEvent 不在锁内）。崩溃窗口导致 events.jsonl 与 index.json 分叉：事件已记录 claim/updated 而 index 仍是旧快照——重启后按 index 口径，已被认领的 WU 显示 unassigned 可被**重复认领双执行**，或 metadata 更新静默丢失。`file-store-workunit.ts:67` 的 `rebuildIndex` 存在但**全仓库零生产调用方**（仅自身定义），启动流程（`index.ts`）不做任何对账。

### M6 — index.json 损坏 = 全线静默停摆（中）

`file-store-workunit.ts:39-60`：index 撕裂/损坏时 readIndexFile 抛错（设计上不静默吞，正确）。但上游没有对应的告警：`observe`（`agent-loop.ts:417`）抛错 → runLoop catch 记日志睡 15s 再循环；timeout-scan / reminder-scan 同样失败。表现 = 所有 agent 永远 idle、超时永不释放，只有日志里重复的错误行。与 H2 同属「FileStore 单点故障无监控」。

### M4 — 优雅关闭不等在飞 step，孤儿 WU 回收慢（中）

`index.ts:385-400`：SIGTERM → `unmountAll`（只置 alive=false + 实例 terminated，`agent-loop.ts:377-388`）→ `server.close` + 5s 强制 exit。**不 await loopPromise**（`agent-loop.ts:391-395` 有 waitForStop 但 shutdown 没调），也不杀 runner 里的 CLI 子进程（`runner-lightweight.ts:119-120,192` 的 runningProcesses 仅用于记账）。后果：

- 在飞 claude CLI 成为孤儿进程继续在 worktree 里写，与稍后新实例的接管执行并发（同 H1 的双写形态）；
- WU 保持 active、assigneeId 指向死 instance，只能等 timeoutAt 到期（默认 60min，metadata 显式值可更长）+ 5min 扫描周期才被释放——重启恢复的最坏延迟是超时全时长，没有启动时的孤儿认领清理。

### L8 — updateState 无锁读-改-写（低）

`file-store.ts:384-387`：`updateState` 读 state.json → 合并 → 写回，无锁。loop 心跳与 timeout-scan 的 terminate 并发时互相覆盖——terminated 可能被迟到的心跳写复活为 idle/active，或心跳被 terminate 覆盖（后者危害小）。与 M10 联动时增加状态抖动。

## 附：本次排查确认「不是问题」的点

- 多 agent 同时 claim 同一 WU：`claimWorkUnit` 在 mkdir 锁内复查 `status==='unassigned'`（`file-store-workunit.ts:98-133`），跨进程安全；竞争败方 1s 后重试（`agent-loop.ts:303-306`）。
- 进程内 eventBus 丢事件（停机期间的 workunit.created/status_changed）：有 15s 轮询读共享 FileStore 兜底拾取，仅延迟不丢失。
- index.json 读写撕裂：writeJson 走 tmp+rename+fsync（`file-store-base.ts:67-83`），读侧不会看到半包。
- 同 profile 双挂载：单活实例守卫（`agent-loop.ts:171-183`）按 pid+心跳新鲜度拦截。
