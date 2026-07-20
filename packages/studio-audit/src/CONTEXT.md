# src

> 此文件描述 packages/studio-audit/src 目录的职责和上下文

## 职责

提供审计日志的记录、查询、导出和链式完整性验证功能。支持通过 `AuditService` 进行持久化日志操作，通过 CLI 模块进行离线查询和导出，并通过 `audit-chain` 实现基于哈希链的防篡改审计记录。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AuditLog`, `LogOptions`, `ExportOptions`, `SearchOptions` | `types.ts` | 审计日志和 CLI 选项的类型定义 |
| `AuditService`, `AuditActions`, `AuditResources` | `services/audit-service.ts` | 核心审计服务，提供日志记录、查询、统计功能 |
| `runLog`, `runExport`, `runSearch` | `cli/log.ts`, `cli/export.ts`, `cli/search.ts` | CLI 接口函数，支持表格/JSON/CSV 输出 |
| `AuditChainEntry`, `AuditAction`, `ChainValidationResult` | `services/audit-chain.ts` | 审计链条目类型及完整性验证结构 |

## 依赖关系

**上游**：依赖 `@dommaker/studio-shared`（FileStore, logger）和 Node 内置模块（path, os, fs, crypto）。

**下游**（以模块归并）：
- `apps/api/src/middleware/audit-logger.ts`：API 中间件，使用审计服务。
- `apps/api/src/modules/audit-logs/routes.ts`：审计日志路由模块。
- `apps/api/src/modules/auth/routes.ts`：认证路由模块。
- `apps/api/tests/security/audit-log.test.ts`：审计日志相关的测试。

## 注意事项

- CLI 模块（`cli/`）使用 **Mock 数据**，仅供开发和演示使用，生产环境需替换为真实服务。
- 服务层 `AuditService` 默认将日志写入 `~/.studio/logs/audit.jsonl` JSONL 文件，依赖文件系统写入权限。
- 审计链模块（`audit-chain`）使用 SHA-256 哈希和签名机制，保证历史记录的不可篡改性。
- 日期输入（如 `ExportOptions.from/to`）必须严格符合 `YYYY-MM-DD` 格式，否则返回错误。
- 所有导出函数返回 `{ output: string, error?: string }`，调用方需检查 `error` 字段。
