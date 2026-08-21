# packages/studio-audit/src

### 职责

提供审计日志的记录、查询、统计与导出功能。通过 `AuditService` 进行持久化日志操作（JSONL 存储）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AuditService`, `AuditActions`, `AuditResources` | `services/audit-service.ts` | 核心审计服务，提供日志记录、查询、统计功能 |
| `AuditLogInput`, `AuditLogQuery`, `AuditLogStats` | `services/audit-service.ts` | 审计日志输入/查询/统计类型 |

### 依赖关系

**上游**：依赖 `@dommaker/studio-shared`（FileStore, logger）和 Node 内置模块（path, os, fs）。

**下游**（以模块归并）：
- `apps/api/src/middleware/audit-logger.ts`：API 中间件，使用审计服务。
- `apps/api/src/modules/audit-logs/routes.ts`：审计日志路由模块。
- `apps/api/src/modules/auth/routes.ts`：认证路由模块。
- `apps/api/tests/security/audit-log.test.ts`：审计日志相关的测试。

### 注意事项

- 服务层 `AuditService` 默认将日志写入 `~/.studio/logs/audit.jsonl` JSONL 文件，依赖文件系统写入权限。
