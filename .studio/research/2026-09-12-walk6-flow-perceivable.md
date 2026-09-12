# 走查⑥流转链路：频道可感知的延迟与断点（#511）

> 范围：PMO `publish` 建 plan WU → analysis-handoff 拆派 task 子单 → review-dispatcher 派评审，只查频道能感觉到的段；PMO/REQ 内部不翻。#443-447 情境引导已修断链不重复。
> 实测：本机真实 `~/.studio/data`（49 WU / 3 频道 / 8 active profile / 最大频道 492 条消息），只读 bench 脚本 `.studio/research/walk6-bench.ts`，2026-09-12 跑。

## 结论先行

1. **三段主链全是同步建单 + 事件驱动，「对账扫描 5min 档」只是断链自愈兜底，不是常态时延。** publish 在一次 HTTP 请求内同步落频道消息 + plan WU；in_review 确认卡、done 拆派清单、review 子单都由 `workunit.status_changed` 事件链同步触发（eventBus 进程内同步 emit）。常态频道感知时延 = ms 级。
2. **频道视角唯一无界的延迟段是人闸**：plan/analysis WU `in_review` → 人工确认，无超时无催办，确认前频道只有一张确认卡。
3. **断链兜底的真实档位 = 10min 宽限 + 5min cron + 60s tick 量化 ≈ 最差 ~16min**；连续 3 次失败停跑升 critical。
4. **两个频道感知断点（非 #443-447 已修部分）**：① review 子 WU 建成 happy path 频道零消息，首次感知靠认领播报，无人认领则完全静默；② 对账自愈（补建 task / 重派 review）按决议在本频道不出声，只走 #62 告警管线，频道无从得知「断过又好了」。
5. **路由 fallback 出声成本已被 #497 冷却闸压到 1 条/小时/频道/档/原因**，单条实测 ~3ms；但 workunit-crud「未配置路由也提示」不走冷却闸，是出声成本的残留热点。

## 分段发现

### 段 1：PMO publish → 频道看到 plan 单

同步一段完成，无扫描档：

- `POST /api/v1/pmo/project/:id/publish` → `projectService.publish` 一次请求内同步：建频道 human 消息（`apps/api/src/modules/pmo/project.service.ts:560`）→ 建 plan WU（:578-626）→ 回写 project.channelId（:641）。路由 fallback 提醒非阻断同请求发出（:630-637）。
- 频道可见性：`ChannelMessageService.createHumanMessage/createAgentMessage` 内 eventBus + SSE 双发（`apps/api/src/modules/channels/channel-message.service.ts:108-109,144-145`），web 单 EventSource `/events/stream` 推送（`apps/web/src/api/websocketHooks.ts`），无轮询档。
- plan WU 被认领：`workunit.created` EVENT 触发器即时唤醒各 loop observe（`apps/api/src/modules/agents/loop/agent-loop.ts:264-287`）；事件丢失兜底 = idle 轮询 15s（`agent-loop.ts:410`）。认领即发声「『角色』已认领任务，开始执行」（`apps/api/src/modules/workunit/claim-announce.ts:33`）。

**时延构成**：HTTP 请求内同步落库（实测相关读口全 ms 级，见下）+ SSE 推送 + loop 事件唤醒 ≈ 秒级内频道看到「需求消息 + 认领播报」。若频道无 active 成员 loop，plan WU 滞留 unassigned，**频道无任何出声**（滞留信号只在 #62 告警管线，非本频道）。

### 段 2：analysis-handoff 拆派 task 子单

- plan WU → `in_review`：ReviewDispatcher 对 MANUAL_GATE_TYPES（含 plan）不派自动评审（`apps/api/src/modules/agents/loop/review-dispatcher.ts:58`）；AnalysisHandoff 在事件链内发确认卡（`apps/api/src/modules/pmo/analysis-handoff.ts:59-62,166-173`）。eventBus emit 同步（`packages/studio-shared/src/event-bus.ts:14-26`），handler 异步 fire-and-forget，实测落盘量级 ms。
- **人闸**：确认无超时无催办（:103-115）。无频道 + trigger 来源 + 无 TASK 的巡检单免确认直转 done（:118-129）；无频道其余情形提示投 Web 收件箱（:132-143）。
- 确认（done）→ `spawnTasks` 事件链内同步建未指派 task 子 WU + 频道发任务清单（:177-245），子 WU `workunit.created` 再唤醒认领。幂等哨兵 `analysisTasksSpawnedAt/Spawned`（:193-199）。

**断链兜底档**：哨兵落档 ≥10min 才参与对账（`apps/api/src/modules/agents/dispatch-reconciliation.ts:36,87`）→ cron `*/5 * * * *`（`apps/api/src/modules/agents/default-triggers.ts:144`）→ SCHEDULE 触发器 60s tick 量化（`apps/api/src/modules/triggers/trigger-scheduler.ts:20,127`）。**最差检测 ≈ 10 + 5 + 1 = 16min**；3 次失败停跑升 critical（dispatch-reconciliation.ts:38,117-123）。

**断点 2a**：对账补建（`respawnScopes`）在本频道不出声（dispatch-reconciliation.ts:6,48 注释，决议 5；`analysis-handoff.ts:320-324` 注释），也不补发任务清单——频道对「补建的子单」的感知只剩后来的认领播报；自愈/失败告警走 #62 管线：`monitor:alert` 事件 + `notifyAlert`（告警频道 + 企业微信 webhook，`apps/api/src/modules/agents/monitor/monitor-alerts.ts:100-121`），均非本频道。

### 段 3：review-dispatcher 派评审

- 父 WU → `in_review`：事件链内同步建 review 子 WU，锁内同父唯一性 guard（review-dispatcher.ts:58-62,109-116,308-322）。
- **断点 3a（happy path 静默）**：建成时频道零消息——只有路由 fallback（:187-193）与自评兜底（:195-205）两种异常才出声。频道首次感知 = 某成员认领播报；若频道内无可认领成员（除实现者外无人 / 都忙），review 子单滞留 unassigned，**频道全程静默**，仅 Web WU 列表可见。
- 评审收口：子 WU done → 解析 `reviewReport` → 父 reviewPassed/reviewRejected（:342-413）；merge-on-review-pass 发里程碑合并消息（`apps/api/src/modules/workunit/merge-on-review-pass.ts:256-298`）；REVIEW_RESULT 缺失转人工频道消息（review-dispatcher.ts:371-374）；迟到 reject 转人工复核（:395-407）。
- 断链兜底同段 2 档：in_review 持续 ≥10min（updatedAt 锚）+ 5min cron + 60s tick ≈ 最差 16min 幂等重派（dispatch-reconciliation.ts:165-195）；人工补派端点 `dispatchReviewNow`（review-dispatcher.ts:221-247）。

### #466/#477/#497 路由表 fallback 出声成本

- 收口骨架 `resolveOrNotice`（`apps/api/src/modules/channels/routing.ts:101-116`），4 个调用点：publish plan 档（project.service.ts:575-577）、analysis-handoff implement 档（analysis-handoff.ts:214-218）、review-dispatcher review 档（review-dispatcher.ts:165）、workunit-crud feature 展开 implement 档（`apps/api/src/modules/workunit/workunit-crud.ts:307-310`）。
- 冷却闸：同频道同档同原因 1h 窗内只出声 1 次（routing.ts:123,131-142）；进程内 Map，重启即重置、补一条可接受（:121-122 注释）。配错场景出声上限 = 3 档 × 1 条/小时/频道。
- **残留热点**：workunit-crud 的 `notConfiguredText`「未配置也提示」**不走冷却闸**（routing.ts:88-89,115——明示与改造前逐点行为一致），feature 展开频次高时每次展开都出声一条。
- 单条出声实测成本：无 anchor 时 `findAnchorMessage` 频道内 `queryMessages` p50 2.8ms / p95 4.6ms（最大频道 492 条消息，bench B1；`wu-messenger.ts:44-53`）+ JSONL append，可忽略。注意 #494 的 `anchorMessageId` 只落在 @mention 派单路径（`apps/api/src/modules/channels/message-routing.ts:312-336,465-482`），publish/拆派/评审建单不落，anchor 查找失败会退到跨频道全扫描（wu-messenger.ts:46-48）。

### 实测数字（bench `.studio/research/walk6-bench.ts`，n=20，本机真实数据）

| 测量 | min | p50 | p95 |
|---|---|---|---|
| getIndex（49 WU，对账/建单 guard 每 tick 必读） | 0.2ms | 0.2ms | 3.1ms |
| 对账 analysis 侧读口（done analysis/plan 过滤，现存 1 候选） | 0.2ms | 0.2ms | 0.8ms |
| 对账 review 侧读口（in_review + 快照，现存 0 候选） | 0.2ms | 0.3ms | 1.7ms |
| listProfiles(active)（路由解析口径，8 profile） | 0.6ms | 0.8ms | 3.5ms |
| queryMessages 最大频道（492 条，anchor 查找口径） | 1.7ms | 2.8ms | 4.6ms |
| getChannel | 0.1ms | 0.1ms | 0.2ms |

结论：当前数据规模下系统侧时延全是设计等待（人闸、cron 量化），IO 完全不构成延迟；数据规模小（49 WU），数字只证明量级、不代表 10x/50x 后仍如此（loop-read-metrics 先例可扩档复测）。

## 候选优化手段清单（只列不评判）

1. review 子 WU 建成时在父 WU 线程补一条轻量「已派评审（#子单号）」系统消息，消除 happy path 静默段。
2. 对账自愈（补建 task / 重派 review）后在本频道补一条「断链已自愈」消息（现决议 5 为不出声，改需过决议）。
3. WU unassigned 滞留超 N 分钟在本频道出声提醒（现仅 #62 告警管线，非本频道）。
4. plan/analysis 人闸超龄催办：in_review 待确认超 X 小时在频道再提醒一次。
5. workunit-crud「未配置路由」提示纳入冷却闸或改为一次性提示（当前每次 feature 展开都出声）。
6. publish / spawnTasks / review 建单路径落 `anchorMessageId`（对齐 #494 mention 路径），消除 anchor 查找跨频道全扫描回退与独立根消息。
7. 对账告警 `notifyAlert` 载荷带本频道/WU 直链（现已带 wuId 链，monitor-alerts.ts:116-119；可评估回本频道的开关）。
