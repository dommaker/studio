# apps/api/src/modules/events

### 职责

提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。

### 核心导出

| 模块 | 路由 | 用途 |
|------|------|------|
| event.routes.ts | POST /api/v1/events | 创建 StudioEvent |
| event.routes.ts | GET /api/v1/events | 查询 StudioEvent（requireAuth；#180 起：type/since/until/level/keyword/workUnitId 过滤 + 尾部倒读游标分页 `cursor`→`nextCursor`，替代全文件线性扫 + 200 硬顶；level 缺省 ≥info，level=debug 看全部；倒读实现 `../../utils/studio-events-tail.ts`） |
| event.routes.ts | POST /api/v1/events/agent-events | 批量写入 AgentEvent[] |
| sse.routes.ts | GET /api/v1/events/stream | SSE 实时事件流 |
| sse.routes.ts | GET /api/v1/events/clients | SSE 客户端列表 (debug) |
| workunit-events-bridge.ts | initWorkunitEventsBridge() | eventBus 的 workunit.created/status_changed + requirement.created/updated（2026-08-24 SSE 负载加深，REQ chips SSE 驱动）→ 'events' 频道（前端 WU 列表/抽屉/REQ chips 实时刷新）；index.ts 启动时调用，幂等 |
| lock-events-bridge.ts | initLockEventsBridge() | #169: eventBus 的 lock.stale_reclaimed/lock.acquire_timeout → 结构化字段落统一事件流 + dispatchMonitorAlerts 全管线（warning 级，不设 critical）；index.ts 启动时调用，幂等 |
| （agent-loop 直发） | workunit.execution.step | WU 执行步事件（思考/工具/skill/用量）：agent-loop 每步结束经 eventBus.publish 直发（不经过桥），`workunit.` 前缀自动落 workunits topic；落盘形态 `workunit:execution_step` 供 GET /events 回放 |
| （agent-loop 直发） | workunit.execution.stream | WU 步内流式 chunk（Layer B，2026-07-30）：step 执行中 CLI stdout 按行提炼 thinking/text/tool/result 直发，**SSE-only 不落盘**（行级体量防膨胀；步级归档走 execution.step）；同前缀落 workunits topic |
| （agent-loop 直发） | workunit.tokens | WU 执行完成的 token 记账（2026-08-24 SSE 负载加深）：writeWorkunitTokenEvent 落盘 workunit:tokens 后顺带发 SSE（data = 落盘现成字段 + channelId），WU 抽屉 token 条事件驱动刷新；同前缀落 workunits topic |
| session-summary-generator.ts | generateSessionSummary() | session:end → session:summary 聚合 |
| session-summary-generator.ts | classifyPattern() (内部) | 根据文件/工具序列分类模式 |

### 依赖关系

- `@dommaker/studio-shared` (FileStore) — jsonl 持久化
- `@dommaker/studio-shared` (eventBus) — SSE pub/sub（#324：SSE 直订 eventBus，event-store 浅适配器已删除；背压 = res.write 返回 false 即断开慢客户端，断开时一并 clearInterval heartbeat 防 write-after-end）
- `../agents/monitor/monitor-alerts.js` — lock-events-bridge 的告警全管线出口（#169）
- `../skills/skill-store.js` — 模式匹配 Skill 建议 (KE-001 P5)

### 测试

五个测试文件，53+ 个用例：

| 文件 | 用例数 | 覆盖内容 |
|------|--------|---------|
| `__tests__/event.routes.test.ts` | 30 | POST/GET/agent-events: 创建/查询/验证/空 payload 拒收（D18）/错误路径；#180 起 GET 用真临时文件 + STUDIO_EVENTS_FILE 缝（过滤/游标/鉴权栈） |
| `__tests__/session-summary-generator.test.ts` | 17 | classifyPattern 13种模式 + generateSessionSummary 边界情况 |
| `__tests__/workunit-events-bridge.test.ts` | 2 | workunit.* + requirement.* 事件转发 'events' 频道（信封形状）；桥 started 幂等是模块态，同文件后续用例 init 为 no-op 靠订阅残留生效 |
| `__tests__/sse-routes.test.ts` | 3 | getTopicFromEventType 映射表锁定（requirement.→requirements、workunit.*→workunits、既有前缀不变） |
| `__tests__/lock-events-bridge.test.ts` | 1 | #169: lock.* 事件 → 结构化事件流 + dispatchMonitorAlerts 全管线（warning + notifyAlert）、init 幂等 |

### 注意事项

- StudioEvent 用 jsonl 文件存储（D18 起统一经 `../../utils/studio-events.js` 的 writeStudioEvent 写入；空 payload 拒绝落盘）
- POST /api/v1/events 的 payload 为空（{} / null / 缺失 / '{}'）→ 400（D18：空事件不产信号只产噪音，调用方自查）
- SSE 使用 EventBus pub/sub (B0-002)，不依赖数据库
- **SSE 帧格式（2026-07-29 修复）**：只写 `id:` + `data:` 匿名事件（不写 `event:` 命名行——EventSource.onmessage 只收匿名事件），且 data 是完整信封 `{event_type, event_id, timestamp, data}`（此前只发内层 payload，客户端按 event_type 分发恒失败，全站 SSE 实际不通）。topic 映射（`getTopicFromEventType` 纯前缀，已导出供单测锁定）：execution./runtime.→executions、node.→nodes、task.→tasks、goal.→goals、knowledge.→knowledge、workunit.→workunits（含 workunit.tokens / workunit.execution.*）、channel.→channels、requirement.→requirements（2026-08-24 新增）、其余→all（客户端默认订阅 all 全收）
- session:summary 在 session:end 时触发，fire-and-forget
- **SSE 与全局 compression（#263 / 根因 #259，2026-08-19）**：app.ts 全局 compression 中间件必须带 `filter: shouldCompress`（`apps/api/src/middleware/compression-filter.ts`）——默认 compressible 对 `text/event-stream` 经 `^text/` fallback 返回 true 会缓冲 SSE 流，频道实时推送全灭。/events/stream 与 /mcp/sse 均经此中间件覆盖；新增 SSE 端点只要走同一 app 即自动生效
- patternType 分类规则：纯 deterministic，不调 LLM
- **鉴权（2026-07-24 收紧）**：event.routes 的 POST /、/agent-events 已收 requireAuth+requireNotGuest；GET /stream 保持公开（Lurk 设计有意放行，会广播内部事件总线）。#180（#60 决策 Q3a）起 GET / 也收 requireAuth。
- **事件检索（#180 / #60 决策 Q3a，2026-08-16）**：GET / 改走 `../../utils/studio-events-tail.ts` 尾部倒读（字节层切行，0x0A 切分防 UTF-8 跨块截断），过滤下推到倒读循环、limit 按匹配数计、扫满即停；游标 = 已扫区间下界字节偏移，无效游标容错重扫最新。读取侧默认 level≥info（envelope 缺省 info），`level=debug` 看全部。Web 消费面 = MonitoringPage「事件检索」Tab。
- **时间窗读口（#335，2026-08-25）**：`readStudioEventsSince({ sinceMs, file? })`（同在 studio-events-tail.ts，与 #180 共用字节层倒扫生成器）——尾部倒读、命中首个窗口外行即停扫，窗口外的行不 parse。**前提：文件 append-only 时间单调**（writeStudioEvent 恒追加、#173 轮转保序）；NaT 行跳过不停扫；返回文件序。已切换的周期读方：monitor-probes(1h)、monitor-reports×4(24h/7d)、auditor-reports(24h)、auditor-rules×2(28d)、evolution/signals(windowHours)、metrics.service×2(windowDays)、pattern-miner(24h)、wu-changed-files(30d 对齐热保留期)。**保持全量读**：monitor-lifecycle 的 precipitate/7d 截断/30d 清理三处——它们重写整个文件，必须拿到窗口外行。bench 数据集（bench/synthesize-dataset.ts）事件副本按 -k*12h 偏移保单调，否则早停前提在合成数据上不成立。
- **保留轮转（#173 / #60 决策 Q3b，2026-08-15）**：`apps/api/src/utils/studio-events-rotation.ts` 每日轮转 studio-events.jsonl——信号（level≥info）热 30 天，超期切 `archive/studio-events-YYYY-MM.jsonl.gz` 月度冷包永久保留；噪声（level=debug：knowledge:*、tool:call）7 天滚动删除。分类口径 = envelope level（显式字段优先，缺省走 type 默认分级）。挂载点：index.ts 启动后跑一次 + 每 24h；测试 `utils/__tests__/studio-events-rotation.test.ts`。
- **其余日志保留轮转（#213，2026-08-19）**：#173 机制泛化为 `apps/api/src/utils/studio-log-rotation.ts`（rotateJsonlLog 配置驱动，studio-events-rotation 委托之）。决议值：incidents.jsonl（信号）热 30 天→月 gzip、audit.jsonl（审计）热 90 天→月 gzip、notifications.jsonl（噪声）7 天滚删；遗留 tasks-*.jsonl 一族 + 残留 ~/.studio/events/incidents.jsonl 一次性 gzip 归档（archive/*-legacy.jsonl.gz）后删除。挂载点：index.ts 与 #173 同节奏；测试 `utils/__tests__/studio-log-rotation.test.ts`。#205 已并入本票。**incidents.jsonl 写入侧（#255，2026-08-20）**：rename 防丢行承诺只对 append-only 写入方成立——triage `updateIncident` 原 readJsonl→整文件 writeFile 覆写会与轮转窗口交错产生行复活/覆盖，已收敛为 append-only：更新以同 id 新行追加（带 updatedAt，`modules/agents/triage/incident-store.ts` appendIncidentUpdate），读方按 rank 归并（updatedAt→createdAt，并列后行胜出）。轮转窗口内热文件不可见时更新 no-op（行不丢、不复活，该次更新丢弃——与旧实现同窗口行为一致）。同 id 并发更新 last-writer-wins，安全前提 = handleAlert 流程内串行 await。
