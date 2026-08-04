# src

> 此文件描述 packages/studio-spec/src 目录的职责和上下文

## 职责

本目录提供 Spec 的验证、变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。它整合三层验证（架构、API、验收），支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| SpecValidatorService | services/spec-validator.service.ts | 综合验证服务，整合架构、API、验收三层验证 |
| ArchitectureValidator | services/architecture-validator.ts | 架构层验证器，检查 metadata 必填字段和依赖有效性 |
| ApiValidator | services/api-validator.ts | API 层验证器，检查 endpoint path/method/schema |
| AcceptanceValidator | services/acceptance-validator.ts | 验收层验证器，检查 AC ID 唯一性、可测试性、无模糊表述 |
| ChangeAnalyzerService | services/change-analyzer.service.ts | 变更分析服务，检测变更类型、计算风险、确定级别、推荐审批流程 |
| ChangeHistoryService | services/change-history.service.ts | 变更历史服务，存储与查询变更记录 |
| GateCheckerService | services/gate-checker.service.ts | 门禁检查服务，执行检查点验证并管理分级策略 |
| isHarnessCheck, HARNESS_CHECK_TYPES | types/gate.types.ts | Harness 检查判断函数与类型常量 |
| 各类 TypeScript 类型（ValidateSpecInput, ValidationResult, ChangeLevel, CheckpointType 等） | types/*.ts | 验证、变更、门禁等模块的类型定义 |

## 依赖关系

**上游依赖**：
- `@dommaker/studio-shared`（提供 logger、parseSpecMarkdown）
- `@dommaker/harness`（动态导入，用于 Harness CheckpointValidator，可选）
- Node.js 内置 `fs`（existsSync）

**下游依赖**：
- `apps/api/src/modules/specs/routes.ts`（API 路由模块，调用本目录的验证与门禁服务）

## 注意事项

- 变更历史服务使用内存存储（`Map`），属于临时方案，后续需接入持久化存储（如 Prisma 或 FileStore）
- Harness 模块采用动态导入（`await import(...)`）以避免循环依赖，失败时降级跳过通用检查
- 架构层验证中，`data_models` 的有效性检查依赖 FileStore 扫描（`~/.studio/schemas/`），当前返回空集，后续需实现
- 模糊表述关键词列表（`VAGUE_KEYWORDS`）用于验收层可测试性检查，可根据业务需要扩展
- 类型定义中 `SpecContent` 没有定义所有字段（如 `api.schemas` 中的具体 schema 结构），需保持与解析器对齐
