# 走查③ 认领延迟：WU 建成 → loop 拾取 → 首个执行步开始的时延构成

- 票：#508（part of #504）  分支：research/walk3-claim-latency  日期：2026-09-12
- 方法：读码为主 + 真 AgentLoop 端到端 bench（`apps/api/bench/claim-latency.ts`，以 ~/.studio 为 1x 模板合成 tmp 副本：49 WU / 3 频道 / 996 事件行；WU 用 test 特征 scope 走 B2 守卫，认领后即关闭，不烧 token）

## 结论先行

1. **票面锚点「workunit.created EVENT trigger 立即唤醒」在当前代码不成立。** EVENT handler（`apps/api/src/modules/agents/loop/agent-loop.ts:269-275`）只 fire-and-forget 跑一次 `observe()`，结果丢弃——不调 `wakeIdle`、不进 resolveTarget/claim。认领只发生在 runLoop 主循环（`agent-loop.ts:401-453`），idle 分支睡满 15s（`agent-loop.ts:410`）。实测 3 轮随机相位建单 → 认领延迟 8527 / 11958 / 12014ms（均匀落于 15s 地板内；若 EVENT 真唤醒应在几十 ms 量级）。
2. **唯一能打断 idle sleep 的是 `channel.message_sent`，且只覆盖「本实例 active/blocked WU 的人类消息」**（`agent-loop.ts:292-293` 订阅、`:661-669` 过滤 + #493 闩锁 `:674-678`；过滤口径 `lastActiveWuIds` 由 observe 每轮刷新 `:773`）。实测 人类消息 publish → 下一次 observe = **4ms**。新建 WU 必不在 `lastActiveWuIds` → **一切建单路径的认领地板 = 0~15s 轮询（均值 ~7.5s）**。
3. **认领互斥/租约开销可忽略**：claim 全链路（getIndex + 文件冲突检查 + flock mkdir 悲观互斥 + 租约写 + status_changed）实测 p50 23.4ms / p95 34.0ms；observe 三读口合计 p50 <1ms。时延几乎全是「等轮询」。
4. **分场景地板**：@mention 派单 = 0~15s + ~40ms；默认角色新建 = 同左，合并窗口并入在途 WU 时视目标 WU 归属（本实例 active/blocked → ~4ms 唤醒；unassigned/他角色 → 0~15s）；线程回复注入（WU 属本实例 active/blocked）= **~4ms + 簿记 <50ms**，但回复若落在步间 plain sleep（`dynamicInterval` 3s/10s/30s，`agent-loop.ts:446` 不可中断）要等余量，worst ~30s（need_input 后）。
5. **即使把 EVENT handler 改成真唤醒，仍有覆盖不到的可认领路径**：auditor okr_proposal 直写 commitSnapshot 绕过 create（`apps/api/src/modules/agents/auditor/auditor-rules.ts:291-316`）；pending→unassigned 人闸确认 / unclaim 释放回池 / blocked→active 复活 / reopen，全部只发 status_changed 不发 created（`apps/api/src/modules/workunit/workunit.service.ts:199-202`、`workunit-crud.ts:527-553`、`waiting-input.ts:143`）；跨进程写者与重启间隙 eventBus 天然丢失（`agent-loop.ts:288-290` 注释自承）。

## 时延构成拆解（WU 建成 → 首个执行步开始）

| 段 | 内容 | 实测/量级 | 佐证 |
|---|---|---|---|
| 建单落盘 | commitSnapshot（appendEvent+upsert 同锁）+ claimable 解析 + `workunit.created` 发布 | p50 12.2ms / p95 22.8ms | `workunit-crud.ts:201-249,284-295`；bench A |
| 等拾取 | idle sleep 地板 15s，随机相位均匀 0~15s | **8527~12014ms（n=3，mean 10.8s）** | `agent-loop.ts:410`；bench B1 |
| observe | getIndex 0.21ms + listChannels 0.18ms + queryAllMessages 0.12ms（p50） | 合计 <1ms | `agent-loop.ts:710-795`；bench A |
| 认领 | flock mkdir 悲观互斥（锁内 status 复查）+ 租约 timeoutAt 写 + status_changed | p50 23.4ms / p95 34.0ms | `workunit-crud.ts:485-522`、`file-store-workunit.ts:160-161`、`file-store-base.ts:27,195`（withLock 超时 5s）；bench A |
| 认领→步开始 | 心跳写 + SSE 发布 + ensureLease + agentStep 前置（守卫/channelVersion/PMO 分支/worktree 创建/prompt 组装）→ executor spawn | 未逐项计时（bench 在 prompt 组装前被 B2 守卫截停）；其中 git worktree add 与 knowledge inject 是该段最大变量 | `agent-loop.ts:428-441,891-893,917-961,1005-1008`、`executor.ts:21-24` |
| 步间调度 | recordResult 后 `sleep(dynamicInterval)`：progress 3s / complete 10s / need_input 30s / failed 15s，**普通 setTimeout 不可中断** | 0~30s（仅步间场景） | `agent-loop.ts:446`、`agent-loop-parsers.ts:150-158` |

补充结构性事实：

- 认领竞争失败方 sleep 1s 重试（`agent-loop.ts:417-420`）；flock 跨进程互斥、进程内 per-lockDir mutex 排队（`file-store-base.ts:195-223`）。
- observe 每轮 unassigned 只取最早 5 条（`agent-loop.ts:759-760`）、myActive 只取最新 20 条（`:719-723`）——突发建单 >5 时排队延迟会超过 15s 地板。
- 租约：认领即写 5min TTL（`workunit-crud.ts:516-517`），持有期 30s 心跳续租（`lease-heartbeat.ts:20`）——是持有期开销，不进认领延迟。
- EVENT trigger 无 filter（`agent-loop.ts:280`）：每次建单触发**所有** loop 各跑一次空 observe（读放大，非延迟问题）。

## 分场景认领延迟地板

### ① @mention 派单（`message-routing.ts:235-422`）

- 链路：先落派发消息（`:315-321`，此时 workUnitId=null）→ `wuService.create`（`:322-358`，status=unassigned）→ `publishCreated`（`workunit-crud.ts:284-295`）→ EVENT observe（结果被丢弃）→ **等 idle 轮询边界** → observe 指名过滤（`agent-loop.ts:741-742`）→ claim。
- 派发消息的 `channel.message_sent` 不唤醒：发布时 workUnitId 为 null（`channel-message.service.ts:94-108`；回填 linkWorkUnit 在建单之后，`message-routing.ts:372`，且发的是 message_updated）。新 WU 也不可能命中 `lastActiveWuIds`。
- **地板 = 0~15s + ~40ms（observe+claim），实测 8.5~12.0s。** 例外：无归属挂起（parked，`:311,326-327`）落 blocked 根本不可认领，等人回复归属后才复活。

### ② 默认角色（决策 12）派单 / #495 合并（`message-routing.ts:425-500`）

- 窗口外/无在途 WU → 新建（`:466-486`）：同 @mention，**0~15s**。
- 合并窗口内（默认 5min，`:55-58`）并入在途 WU 线程（`:430-463`）：
  - 目标 WU 属本实例且 active/blocked → `channel.message_sent`（workUnitId 命中 lastActiveWuIds）**~4ms 唤醒**（bench B2）；回复经 pendingReplies 注入（`waiting-input.ts:81-88` 或 `:442-457`），实际消费在下一步 prompt。
  - 目标 WU unassigned/pending（未认领/人闸中）→ 不在任何实例的 lastActiveWuIds → 不唤醒，WU 拾取仍 **0~15s**（合并消息只是搭车）。
- 若 loop 正处于步间 plain sleep（`dynamicInterval`），闩锁要等 idleSleep 入口才消费（`agent-loop.ts:674-678`）→ 延迟余量 worst ~30s。

### ③ 线程回复注入（replyTo，`message-routing.ts:189-216`）

- 链路：继承父消息 workUnitId（`:200`）→ 落人类消息（发 `channel.message_sent`，`channel-message.service.ts:108`）→ `resumeWaitingWorkUnit`（`:209-216`；blocked→active + pendingReplies，`waiting-input.ts:64-147`）。
- WU 属本实例 active/blocked（在 lastActiveWuIds）→ **唤醒 ~4ms**（bench B2 publish→observe 实测），下一 tick observe 新回复检测（`agent-loop.ts:781-792`，>= updatedAt 水位线，#493 同毫秒边界）→ agentStep。**地板 ≈ 毫秒级 + 簿记 <50ms，是三场景里唯一事件驱动全覆盖的。**
- 盲区：a) 回复落在步间 plain sleep → 等 dynamicInterval 余量（worst ~30s）；b) WU 不属本实例（跨角色/unassigned 合并目标）→ 退回 15s 地板；c) 父消息已归档冷层（#327）→ 降级放行不触达任务（`message-routing.ts:195-199,219-230`）。

## EVENT 唤醒覆盖不到的建单/可认领路径

按「假设 EVENT handler 已修复为真唤醒」盘点仍漏的路径：

1. **auditor okr_proposal 建单旁路**：直写 `fileStore.commitSnapshot` 绕过 `WorkUnitService.create`，无 `publishCreated`（`apps/api/src/modules/agents/auditor/auditor-rules.ts:291-316`）。
2. **pending → unassigned 人闸确认**：feature/task/spec 默认落 pending（`workunit.types.ts:340-353` PENDING_CONFIRM_TYPES），确认走 transitionStatus 只发 status_changed（`workunit.service.ts:199-202`）。确认时展开的 routing 子单走 create 有事件，被确认的父单本身没有。
3. **unclaim 释放回池**：超时释放（timeout-release）/人工释放 → unassigned，只发 status_changed（`workunit-crud.ts:527-553`）。
4. **blocked → active 复活**：`resumeWaitingWorkUnit` 走 transitionStatus（`waiting-input.ts:143`），无 created 事件——但同消息流的 `channel.message_sent` 唤醒补位（限 lastActiveWuIds 内 WU）。
5. **reopen closed → unassigned**（`workunit.service.ts:218-224`）。
6. **进程外写者 / 重启间隙**：eventBus 进程内 fire-and-forget 无持久，跨进程建单与重启间隙的事件天然丢失，靠 15s 轮询 + 启动首轮 observe 兜底（`agent-loop.ts:288-290` 注释自承此语义）。
7. 现状下（handler 只 observe 不唤醒）以上全部等价：**所有路径统一吃 0~15s 地板**。

## 实测数字汇总（bench/claim-latency.ts，1x 生产规模合成副本）

```
Phase A 组件耗时（n=30, ms）:
  getIndex          p50 0.21  p95 0.34
  listChannels      p50 0.18  p95 0.57
  queryAllMessages  p50 0.12  p95 0.29
  create            p50 12.2  p95 22.8   （含 flock + claimable 解析 + 事件发布）
  claim             p50 23.4  p95 34.0   （含 flock 互斥 + 租约写 + status_changed）

Phase B 真 AgentLoop 端到端:
  B1 建单→认领（随机相位 n=3）: 8527 / 11958 / 12014ms（mean 10.8s，∈ 15s idle 地板）
  B2 人类消息 publish→下一次 observe: 4ms
```

口径备注：B1 的 claimedAt 取自 index 快照（1ms 精度），轮询检出粒度 50ms；B2 以插桩 FileStore 的 getIndex 调用时刻为 observe 指纹。bench 数据根在 tmp（合成副本，已清理），脚本留存 `apps/api/bench/claim-latency.ts` 可复跑。

## 候选优化手段（只列，不评判优先级、不动手）

1. EVENT handler 真唤醒：`agent-loop.ts:269-275` 的 observe-only handler 改为置 pendingWake + 调 `wakeIdle`（复用 #493 闩锁），让建单即刻驱动一轮完整 loop 迭代——单点改动覆盖全部经 publishCreated 的建单路径。
2. 唤醒按事件负载过滤：workunit.created 负载已带 assigneeId/channelId/claimable，可按「指名本 role 或本频道成员」选择性唤醒，避免每次建单唤醒全部 loop。
3. auditor-rules 建单旁路改走 `WorkUnitService.create`（或补 publishCreated 调用），消除无事件建单。
4. 可认领迁移补事件：transitionStatus/unclaim 落入 unassigned 时补发「可认领」事件（或 loop 订阅 workunit.status_changed 并按负载 claimable 过滤），把人闸确认 / 超时释放 / reopen 纳入事件驱动。
5. 缩短 idle 地板：15s → 2~5s（observe 单轮实测 <1ms，空转成本可忽略），或事件 + 短轮询双保险。
6. 步间 sleep 可中断：`dynamicInterval` 的 plain sleep 改走可消费 pendingWake 闩锁的 idleSleep 同款，让步间到达的线程回复即时注入。
7. 扩展 message_sent 唤醒过滤口径：对「unassigned 且指名本 role」的 WU 的合并/回复消息也唤醒（当前只认 lastActiveWuIds）。
8. 跨进程兜底：FileStore index.json mtime 监视（fs.watch）作为事件总线之外的唤醒源，覆盖未来跨进程写者。
