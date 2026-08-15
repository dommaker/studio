# events

> 此文件描述 apps/api/src/modules/events 目录的职责和上下文

## 职责

提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。

## 核心导出

| 模块 | 路由 | 用途 |
|------|------|------|
| event.routes.ts | POST /api/v1/events | 创建 StudioEvent |
| event.routes.ts | GET /api/v1/events | 查询 StudioEvent (type/since/limit/workUnitId 过滤；workUnitId 按 payload.workUnitId 匹配，供 WU 执行步回放) |
| event.routes.ts | POST /api/v1/events/agent-events | 批量写入 AgentEvent[] |
| sse.routes.ts | GET /api/v1/events/stream | SSE 实时事件流 |
| sse.routes.ts | GET /api/v1/events/clients | SSE 客户端列表 (debug) |
| workunit-events-bridge.ts | initWorkunitEventsBridge() | eventBus 的 workunit.created/status_changed → 'events' 频道（前端 WU 列表/抽屉实时刷新）；index.ts 启动时调用，幂等 |
| （agent-loop 直发） | workunit.execution.step | WU 执行步事件（思考/工具/skill/用量）：agent-loop 每步结束经 eventStore.publish 直发（不经过桥），`workunit.` 前缀自动落 workunits topic；落盘形态 `workunit:execution_step` 供 GET /events 回放 |
| （agent-loop 直发） | workunit.execution.stream | WU 步内流式 chunk（Layer B，2026-07-30）：step 执行中 CLI stdout 按行提炼 thinking/text/tool/result 直发，**SSE-only 不落盘**（行级体量防膨胀；步级归档走 execution.step）；同前缀落 workunits topic |
| session-summary-generator.ts | generateSessionSummary() | session:end → session:summary 聚合 |
| session-summary-generator.ts | classifyPattern() (内部) | 根据文件/工具序列分类模式 |

## 依赖关系

- `@dommaker/studio-shared` (FileStore) — jsonl 持久化
- `../../core/event-store.js` (EventStore) — SSE pub/sub
- `../skills/skill-store.js` — 模式匹配 Skill 建议 (KE-001 P5)

## 测试

三个测试文件，42+ 个用例：

| 文件 | 用例数 | 覆盖内容 |
|------|--------|---------|
| `__tests__/event.routes.test.ts` | 24 | POST/GET/agent-events: 创建/查询/验证/空 payload 拒收（D18）/错误路径 |
| `__tests__/session-summary-generator.test.ts` | 17 | classifyPattern 13种模式 + generateSessionSummary 边界情况 |
| `__tests__/workunit-events-bridge.test.ts` | 1 | workunit.* 事件转发 'events' 频道（信封形状） |

## 注意事项

- StudioEvent 用 jsonl 文件存储（D18 起统一经 `../../utils/studio-events.js` 的 writeStudioEvent 写入；空 payload 拒绝落盘）
- POST /api/v1/events 的 payload 为空（{} / null / 缺失 / '{}'）→ 400（D18：空事件不产信号只产噪音，调用方自查）
- SSE 使用 EventBus pub/sub (B0-002)，不依赖数据库
- **SSE 帧格式（2026-07-29 修复）**：只写 `id:` + `data:` 匿名事件（不写 `event:` 命名行——EventSource.onmessage 只收匿名事件），且 data 是完整信封 `{event_type, event_id, timestamp, data}`（此前只发内层 payload，客户端按 event_type 分发恒失败，全站 SSE 实际不通）。topic 映射：execution./runtime.→executions、node.→nodes、task.→tasks、goal.→goals、knowledge.→knowledge、workunit.→workunits、channel.→channels、其余→all（客户端默认订阅 all 全收）
- session:summary 在 session:end 时触发，fire-and-forget
- patternType 分类规则：纯 deterministic，不调 LLM
- **鉴权（2026-07-24 收紧）**：event.routes 的 POST /、/agent-events 已收 requireAuth+requireNotGuest；GET /stream 保持公开（Lurk 设计有意放行，会广播内部事件总线）。
- **保留轮转（#173 / #60 决策 Q3b，2026-08-15）**：`apps/api/src/utils/studio-events-rotation.ts` 每日轮转 studio-events.jsonl——信号（level≥info）热 30 天，超期切 `archive/studio-events-YYYY-MM.jsonl.gz` 月度冷包永久保留；噪声（level=debug：knowledge:*、tool:call）7 天滚动删除。分类口径 = envelope level（显式字段优先，缺省走 type 默认分级）。挂载点：index.ts 启动后跑一次 + 每 24h；测试 `utils/__tests__/studio-events-rotation.test.ts`。audit.jsonl/incidents.jsonl 的 30 天热+月度 gzip 同属 #60 Q3b 但未在任何子票范围，待后续立项。
