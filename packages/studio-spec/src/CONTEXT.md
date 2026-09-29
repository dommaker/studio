# packages/studio-spec/src

### 职责

本目录提供 Spec 的变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| ChangeAnalyzerService | services/change-analyzer.service.ts | 变更分析服务，检测变更类型、计算风险、确定级别、推荐审批流程 |
| ChangeHistoryService | services/change-history.service.ts | 变更历史服务，存储与查询变更记录 |
| GateCheckerService | services/gate-checker.service.ts | 门禁检查服务：L1-L4 策略与五个业务 checker 在本包；通用检查（file_exists 等 4 种）直接以 harness 原生 Checkpoint/CheckpointCheck 表达，交 harness CheckpointValidator 执行 |
| isHarnessCheck, HARNESS_CHECK_TYPES | types/gate.types.ts | Harness 检查判断（type guard）与路由常量；HarnessCheckConfig = harness `CheckConfig` 别名 |
| 各类 TypeScript 类型（ChangeLevel, CheckpointType, GatePolicy 等） | types/*.ts | 变更、门禁等模块的类型定义 |

### 依赖关系

**上游依赖**：
- `@dommaker/studio-shared`（提供 logger）
- `@dommaker/harness`（动态导入，用于 Harness CheckpointValidator，可选）

**下游依赖**：
- `apps/api/src/modules/specs/routes.ts`（API 路由模块，调用本目录的变更与门禁服务）

### 注意事项

- 变更历史服务使用内存存储（`Map`），属于临时方案，后续需接入持久化存储（如 Prisma 或 FileStore）
- Harness 模块采用动态导入（`await import(...)`）以避免循环依赖，失败时降级：L1/L2 非严格模式跳过、L3/L4 或严格模式判失败（降级语义见 gate-checker.degradation.test.ts）
- 通用检查不再自建构造/分发层（studio#644）：检查项即 harness `CheckpointCheck`（`config` 为 harness `CheckConfig`），上下文为 harness `CheckpointContext`（`projectPath`/`workdir`）
- 类型定义中 `SpecContent` 没有定义所有字段（如 `api.schemas` 中的具体 schema 结构），需保持与解析器对齐
