# harness

> 此文件描述 apps/api/src/modules/harness 目录的职责和上下文

## 职责

Harness 监控与治理 API（FL-029 / T-015）：轨迹采集分析、约束生命周期、
安全护栏、知识引擎、会话/Agent 管理、错误分类与验证、仪表盘。

路由结构（T3 大文件拆分 5/N，2026-07-19）：`routes.ts` 为挂载门面，
处理器按资源拆分为子路由，共享运行时集中于 `runtime.ts`：

| 文件 | 职责 |
|------|------|
| `runtime.ts` | @dommaker/harness 懒加载、Collector/Analyzer/KnowledgeStore 单例、TTL 缓存 |
| `routes.ts` | 挂载门面（默认导出 Router，route-registry 挂 /api/v1/harness + /api/v1/cso） |
| `traces.routes.ts` | 轨迹采集/分析/诊断（/traces、/analysis、/diagnose） |
| `proposals.routes.ts` | 约束进化与提案（/proposals、/evolve） |
| `constraints.routes.ts` | 约束生命周期 + 质量门（/constraints*、/check-constraints） |
| `guards.routes.ts` | 安全护栏（/check-input、/check-output、/sandbox） |
| `knowledge.routes.ts` | 知识引擎（/knowledge*） |
| `sessions.routes.ts` | 上下文管理（/estimate-tokens、/sessions*） |
| `agents.routes.ts` | Agent 生命周期（/agents*） |
| `diagnostics.routes.ts` | 错误分类/规格检查/验证（/classify、/failures、/check-spec、/verify*） |
| `dashboard.routes.ts` | 仪表盘/健康（/dashboard、/health） |
| `cso.routes.ts` | CSO 验证（/validate，挂 /api/v1/cso 无 auth） |
| `iron-laws.routes.ts` | Iron Laws（独立子路由，挂 /api/v1/iron-laws） |

## 核心导出

- `routes.ts` default export：express Router（44 个端点，见门面注释）

## 依赖关系

- 依赖 `@dommaker/harness`（懒加载，不可用时端点降级 503）
- 依赖 `@dommaker/studio-shared`（logger）、`../knowledge/knowledge-bus.service.js`（UNIFIED_KNOWLEDGE_DIR）
- 被 `apps/api/src/route-registry.ts` 引用（/api/v1/harness 带 auth、/api/v1/cso 无 auth）

## 注意事项

- 子路由路径首段字面前缀互不重叠；唯一前缀包含关系 /constraints/stats 先于
  /constraints/:id 注册（constraints.routes.ts 内保持顺序）。
- 提案持久化于 `process.cwd()/.harness/proposals/`；会话与 AgentLifecycle 为内存态。
- GET /knowledge 有 30s TTL 缓存（runtime.ts）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `ee1e354d`: B39 harness 集成修复 — A5 checkConstraint + S13 routes 类型化
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
