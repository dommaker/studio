# events

> 此文件描述 apps/api/src/modules/events 目录的职责和上下文

## 职责

提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。

## 核心导出

| 模块 | 路由 | 用途 |
|------|------|------|
| event.routes.ts | POST /api/v1/events | 创建 StudioEvent |
| event.routes.ts | GET /api/v1/events | 查询 StudioEvent (type/since/limit 过滤) |
| event.routes.ts | POST /api/v1/events/agent-events | 批量写入 AgentEvent[] |
| sse.routes.ts | GET /api/v1/events/stream | SSE 实时事件流 |
| sse.routes.ts | GET /api/v1/events/clients | SSE 客户端列表 (debug) |
| session-summary-generator.ts | generateSessionSummary() | session:end → session:summary 聚合 |
| session-summary-generator.ts | classifyPattern() (内部) | 根据文件/工具序列分类模式 |

## 依赖关系

- `@dommaker/studio-shared` (FileStore) — jsonl 持久化
- `../../core/event-store.js` (EventStore) — SSE pub/sub
- `../skills/skill-store.js` — 模式匹配 Skill 建议 (KE-001 P5)

## 测试

两个测试文件，40 个用例：

| 文件 | 用例数 | 覆盖内容 |
|------|--------|---------|
| `__tests__/event.routes.test.ts` | 23 | POST/GET/agent-events: 创建/查询/验证/错误路径 |
| `__tests__/session-summary-generator.test.ts` | 17 | classifyPattern 13种模式 + generateSessionSummary 边界情况 |

## 注意事项

- StudioEvent 用 jsonl 文件存储 (FileStore.appendJsonl)
- SSE 使用 EventBus pub/sub (B0-002)，不依赖数据库
- session:summary 在 session:end 时触发，fire-and-forget
- patternType 分类规则：纯 deterministic，不调 LLM
- **鉴权（2026-07-24 收紧）**：event.routes 的 POST /、/agent-events 已收 requireAuth+requireNotGuest；GET /stream 保持公开（Lurk 设计有意放行，会广播内部事件总线）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: P0 修复 5 — session-summary-generator/event.routes 的 studio-events.jsonl 走 utils/studio-log-path 测试隔离（生产行为不变）
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
