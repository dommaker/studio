# apps/api/src/modules/audit-logs

### 职责

提供审计日志的查询与统计 API 端点，支持按用户、角色、公司、操作类型、资源、状态、时间范围等条件过滤，并支持分页查询和统计汇总。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` (默认导出) | routes.ts | Express 路由对象，包含 `GET /api/audit-logs`（查询日志）和 `GET /api/audit-logs/stats`（获取统计）两个端点。 |
| `queryProposalDecisionRows` / `getProposalDecisionRowById` / `collectProposalDecisionRows` / `filterProposalDecisionRows` | proposal-source.ts | #591 A 类：review-proposal 7 种 kind 的聚合读面（零新写入，折叠归各 adapter store 正本），映射 audit 行形状（actorType=agent, action=propose, resource=kind, status=提案终态原值）；details 含卡片作者（adapter.author），详情回查（getProposalDecisionRowById）带提案全文；已知 kind 未注册时 warn 留痕不静默缺源 |
| `recordAgentDecision` / `AuditActor` | agent-decision.ts | #591 B 类：自主决策埋点统一入口（fire-and-forget，失败只记日志不阻断业务链） |

### 决策词表（治理变更条目，出处 #591 + ADR 2026-09-17 决策 2；增删走治理变更流程）

agent 自主决策埋点的 action/resource 词表：

| action | resource | 决策点 | 埋点位置 |
| --- | --- | --- | --- |
| `propose` | 提案 kind（distill/gc/audit/memory/skill/knowledge/auditor） | A 类：经人审决策聚合读面（无新写入） | proposal-source.ts |
| `claim` | `workunit` | WU 认领（loop 涌现 + REST 引导片同原语） | workunit/claim-announce.ts |
| `transition` | `workunit` | WU 状态机流转（仅真实迁移落账） | workunit.service.ts persistSnapshot |
| `dispatch` | `workunit` | @mention 派单 / 决策12 默认角色 / 合并窗口并入（details.via 区分） | channels/message-routing.ts |
| `create` / `execute` / `update` | `trigger` | trigger 触发（含手动 fire，details.manual 区分） | triggers/trigger-scheduler.ts executeTrigger、trigger.routes.ts |
| `auto_apply` | 建议 type（skill_weight/skill_status/circuit_fix） | auditor 低风险建议自动应用 | agents/auditor/auditor-execution.ts |

行形状：actorType=agent；决策主体 → roleId（actor.type=human 时 userId）；依据 → details（摘要，不落全 payload）；traceId → requestId（频道链路复用 ctx.traceId，trigger/auditor 现场生成 randomUUID）。

### 依赖关系

- **上游依赖**：`../../utils/logger.js`（日志）、`../../utils/pagination.js`（分页格式化）、`../../utils/services.js`（惰性服务工厂）、`@dommaker/studio-audit`（审计服务与枚举）、`@dommaker/studio-shared`（FileStore）、`express`。
- **下游依赖**：`apps/api/src/route-registry.ts` 注册此模块的路由。

### 注意事项

- 查询参数 `anonymousId` 为 SEC-009 新增字段，需确保前端传递正确。
- #591：`actorType`（human/agent，human 归一匹配存量无字段行）与 `source`（operation|proposal|all，缺省 operation 保持既有行为）两个维度；source 含 proposal 时合并 review-proposal 聚合行统一排序分页，`GET /:id` 未命中回查提案源；stats 端点维持操作轨口径不混提案源。
- 所有错误场景统一返回 `{ error: { code, message } }` 格式，内部日志使用 `logger.error`。
- 审计服务通过 `createLazyService` 延迟初始化，避免启动时加载依赖。
- 分页默认值为 page=1, limit=20（上限 100），统一走 `parsePagination`（#359：堵 limit=999999 直通豁口，原缺省 50 无 clamp）。
- **鉴权（2026-07-24 收紧）**：`/api/v1/audit-logs` 挂载级 `requireAuth()+requireAdmin()` —— 日志含 IP/UA/email（PII），且 `POST /`（伪造审计）、`POST /cleanup`（销毁证据）此前无角色限制。`GET /export` 曾注册在 `GET /:id` 之后被遮蔽不可达（历史 bug），2026-09-09 已修复：/export 移到 /:id 之前，并补 action/resource/status 过滤透传（与列表口径一致，E7 前端已带参）。
