# 走查④回执呈现：系统播报与 SSE 扇出的开销（#509）

- 日期：2026-09-12
- 范围：系统播报路径（createAgentMessage 唯一发布路径）、SSE 扇出、事件负载契约符合性；重点嫌疑点⑥ execution-step-events.ts:421-430 Layer B 逐 chunk 扇出成本
- 方法：读码 + 实测（bench 脚本喂真实会话数据，跑在主 checkout 源码上，只读）

## 结论先行

1. **嫌疑点⑥不成立为性能问题**：Layer B 逐 chunk `eventBus.publish` + SSE 扇出的服务端成本实测为微秒级（1 客户端 1.4µs/事件、20 客户端 24µs/事件），一次典型执行步（≈26 个 chunk）总扇出成本 <1ms。真正的成本不在 CPU，而在**网络字节量**与 **replay buffer 挤占**（见发现 3、4）。
2. **一次典型执行的 SSE 事件量量级**：实测真实会话数据，每个 stream-json 行恰好产 1 个 chunk（868/868），典型步 ≈26 个 stream chunk（信封均 533B），即每步 ≈26 帧 ≈14KB；重步上界 ~155 帧。一次 WU 执行（多步）量级 = 数十到数百帧、数十 KB——量级温和。
3. **事件负载契约符合**：Layer A/B 负载均自足（chunk 带 workUnitId/step/kind/text 全量），前端消费端零 REST 补拉（useWorkUnitStreamEvents 纯内存；ExecutionSteps/ExecutionFlow 首拉打底 + SSE 就地 append + 重连一次性 refetch——契约明文允许的形态）。无门铃事件。
4. **唯一发布路径属实**：`channel.message_sent` 全仓仅 channel-message.service.ts:108/144 两处发出（createHumanMessage/createAgentMessage 内），wu-messenger 等全部委托于此；audit 订的是 `events:audit` 独立 topic，不吃 Layer B 流量。
5. **播报流程无明显多余/缺失**；可批处理/降频空间存在但收益主要在网络帧数与 replay buffer 纯度，不在服务端 CPU。

## 分嫌疑点/分问题发现

### ⑥ Layer B 逐 chunk 扇出成本（execution-step-events.ts:421-430）

机制：`agent-loop.ts:1096-1098` onStreamLine 每行 → `emitExecutionStreamLine`（execution-step-events.ts:433-441）→ `buildExecutionStreamChunks` 提炼 0..n chunk → `publishStreamChunks`（421-430）逐 chunk `eventBus.publish('events', …)`。`events` topic 生产环境唯一订阅者 = sse.routes.ts:60（其余命中均为测试），扇出 = topic 前缀映射（sse.routes.ts:42-53）→ replay buffer 入队（:65）→ 每订阅客户端 `JSON.stringify` + 2 次 `res.write`（:79-93）。

实测（bench 脚本跑 100k 次迭代均值，Node 同进程；数据源 = `~/.claude/projects/-root-projects-studio*` 最近 40 个真实会话文件，与 stream-json 行同构）：

| 项 | 实测值 |
|---|---|
| 每行产 chunk 数 | 868 行全部恰好 1 chunk（chunksPerLineDist `{1: 868}`），0 产出行 0 |
| chunk kind 分布 | tool 298 / tool-result 298 / thinking 190 / text 82 |
| SSE 信封字节 | 均 533B，最大 892B（容量纪律：单 chunk ≤500 字符，execution-step-events.ts:297） |
| 会话行数（≈步内事件数） | 均 31、中位 11、最大 155；步均 ≈ 868行/34步 ≈ 26 帧 |
| eventBus.publish 裸开销 | 0.14µs/次 |
| 服务端整链路扇出 | 1 客户端 1.4µs、5 客户端 5.9µs、20 客户端 24.2µs（每事件） |
| Web 端分发（JSON.parse + N handler 早退） | 5 handler 1.6µs、10 handler 1.8µs（每事件） |

推算：典型一步 ≈26 帧，20 个并发 SSE 客户端下服务端总成本 ≈ 26 × 24µs ≈ 0.6ms，摊在几分钟的步时长里可忽略。网络侧 ≈ 26 × 533B × 客户端数 ≈ 14KB/步/客户端。

### SSE 事件量量级（一次典型执行）

- Layer B（stream，SSE-only 不落盘，execution-step-events.ts:292-295）：每步 ≈26 帧（上界 ~155 帧/重步）+ 1 帧 step-start（agent-loop.ts:1156）+ 1 帧 result（execution-step-events.ts:392-400，空文本也产，作「本回合结束」信号）。
- Layer A（step，落盘 + SSE，execution-step-events.ts:230-246）：每步 1 帧，负载 ≤30 toolCall×160 字符 + 3×500 thinking + 500 text ≈ 上界 ~7KB（容量纪律 :44-48）。
- 频道播报（回执本体）：recordResult → postToDiscussionSpace（agent-loop.ts:1930-1942）→ postWuSystemMessage（wu-messenger.ts:101-133）→ createAgentMessage，每条频道消息 1 帧 `channel.message_sent`（channel-message.service.ts:144-145）；里程碑消息另写 NotificationService 持久通知（wu-messenger.ts:77-95，仅 milestone，非每帧成本）。
- 合计一次典型执行（1 步）：**~30 帧 / ~15-20KB**；一个 WU 走完（步安全阀 15 步，agents/CONTEXT.md:24）：**数百帧 / 数百 KB 量级**。

### 扇出成本落在哪（各订阅端）

- **服务端**：微秒级 CPU（上表），可忽略；真实成本 = socket 写字节 × 客户端数。背压策略已就位：write 返回 false 即断开慢客户端（sse.routes.ts:84, 95-100）。
- **Web 端**：全应用唯一 EventSource（web/src/CONTEXT.md:86，websocket.tsx:9-15 单一 handlersRef 分发）；每帧 1 次 JSON.parse + ~5-10 个早退 handler ≈ 2µs。渲染成本已被架构压掉：stream chunk 只重渲抽屉实时区块（useWorkUnitStreamEvents.ts:13-43，内存上限 50 条）与对应 roster 卡切片（rosterActivityStore，#348 状态下沉，render-count 测试锁定既有消息项零重渲）。
- **audit/通知**：audit 订 `events:audit`（audit-subscriber.ts:10），与 `events` topic 无交集；通知只在 milestone 落持久通知。两者对 Layer B 零成本。

### replay buffer 挤占（实测关联的次生发现）

sse-replay-buffer 是全 topic 共享的 500 条环形 buffer（sse-replay-buffer.ts:23, sse.routes.ts:27）。Layer B chunk 与 `channel.message_sent`/`workunit.status_changed` 等关键事件同坑竞争：一个活跃执行每步 ~26 帧 stream chunk，500 条窗口 ≈ 19 步的纯 stream 流量即打满——多执行并发时，重连 Last-Event-ID 补发窗口内关键事件可能已被 stream chunk 挤出（replay 返回 null → 前端全量 refetch 兜底，sse-replay-buffer.ts:51-57，正确性无损，但 #491 的补发机制在高 stream 负载下实际失效）。

### 事件负载契约符合性

根 CONTEXT.md:113-115 契约：①归属身份 ②足量负载、禁 REST 补拉 ③additive ④断线重连一次性 refetch。逐条核：

- Layer B chunk：workUnitId/executionId/channelId/step/kind/text/toolUseId 全量自足（execution-step-events.ts:302-320）；useWorkUnitStreamEvents 纯内存消费零补拉（:26-38）。符合。
- Layer A step：负载含 thinking/toolCalls/text/usage 全量摘要（:56-82）；ExecutionSteps/ExecutionFlow 负载就地 append、executionId-step 去重，重连才 refetch（web/src/CONTEXT.md:89 批 4）。符合。
- 频道消息：`channel.message_sent`/`message_updated` 均挂全量 shaped message 本体（channel-message.service.ts:144-145, 174-180，#311 ADR D1/D2）。符合。
- 无门铃事件形态。

### 播报流程多余/缺失

- 双发观察：createAgentMessage 同 payload 发两次——eventBus `channel.message_sent` topic（:144，订阅者 = agent-loop 唤醒 agent-loop.ts:293、evolution channel-review channel-review.ts:121）+ SSE 信封经 `events` topic（:145）。两路订阅者不同，不算冗余。
- 无明显缺失：`workunit:failed` 只落盘不进频道为显式设计（execution-step-events.ts:271-273，频道里程碑由 recordResult 负责）；Layer B 无 REST 回放同为显式设计（:14-15，步级归档由 Layer A 负责）。
- 轻微不一致：SSE 信封发布在三处各自手写（channel-message.service.ts:73-81 publishSSE、execution-step-events.ts:235-240 / 421-430），无统一 helper——风格观察，非缺陷。

## 候选优化手段清单（只列，不评判优先级）

1. **stream chunk 合并帧**：publishStreamChunks 逐 chunk 发改为单行 chunks 合并一帧（数组负载）——但实测 1 chunk/行，收益近零，仅防未来多块行。
2. **服务端时间窗批处理**：按 executionId 250-500ms 窗口合并 thinking/text chunk 成一帧，burst 期帧数可降 5-10×；抽屉端按数组展开，渲染次数同步下降。
3. **stream 类事件不进 replay buffer**（或 buffer 按 topic 分桶）：chunk 前端只留当前步、无重放价值，踢出后 500 条窗口全留给关键事件，#491 补发机制在高负载下恢复有效。
4. **chunk 负载再裁剪**：thinking/text chunk 500 字符对 roster 动态文案（只用前几十字）与抽屉实时行均富余，可降至 ~120-200 字符，字节量立降 60%+。
5. **兴趣信号降频**：无客户端订阅 workunits topic / 无抽屉打开时服务端跳过 build+publish——需客户端上行兴趣或按 clients 订阅 topics 判断（sse.routes 已有 clients.topics 可查，可零协议改动实现「无 workunits 订阅者则不扇出」的前半段；build 成本仍在）。
6. **前端 rAF/微批 setState**：useWorkUnitStreamEvents/rosterActivityStore 对 burst chunk 按动画帧合批，再降渲染次数（当前已被状态下沉压住，属锦上添花）。

## 附：测量方法与数据口径

- bench 脚本（未提交）：worktree `tmp-walk4/bench-sse-fanout.ts`，以 `npx tsx` 在主 checkout 跑（只读），直接 import 主 checkout 的 `buildExecutionStreamChunks` / `SseReplayBuffer` / `eventBus`。
- 数据源：`~/.claude/projects/-root-projects-studio*` 最近 40 个会话 jsonl（33 文件，28 个含有效行）；会话行与 stream-json stdout 行同构（`{type, message:{content:[blocks]}}`，过 `parseStreamLine`），过滤 type∈{assistant,user} 且 content 为块数组的行；stepPrompts=34（type=user 且 content 为 string 的行 ≈ 新步 prompt）。
- 局限：本机会话偏短（冒烟/开发会话多），重负载步以 maxLinesPerSession=155 为上界参考；B/C 段计时为单进程微基准，不含真实 socket/内核缓冲行为（背压路径由 sse.routes.ts:84 断开策略覆盖，未测）。
