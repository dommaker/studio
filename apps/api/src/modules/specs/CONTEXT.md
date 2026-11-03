# apps/api/src/modules/specs

### 职责

Specs 域：变更分析（L1-L4 分级与审批推荐）、变更历史查询、门禁验证（SP-002/SP-003）。服务实现自 packages/studio-spec 并回本模块（#684 包下沉）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `specsOpenRoutes` / `specsWriteRoutes` | `routes.ts` | Express 路由（open=读+analyze-change / write=validate+import，鉴权挂 route-registry） |
| `ChangeAnalyzerService` / `changeAnalyzerService` | `change-analyzer.service.ts` | 变更分析：检测变更类型、计算风险、确定级别、推荐审批流程 |
| `ChangeHistoryService` / `changeHistoryService` / `toChangeRecordWire` | `change-history.service.ts` | 变更历史：进程内 Map 存储与查询；路由出口统一把 submittedAt/approvedAt/appliedAt 转为 ISO wire |
| `GateCheckerService` / `gateCheckerService` | `gate-checker.service.ts` | 门禁检查：L1-L4 策略 + 五个业务 checker 在本模块；通用检查以 harness 原生 Checkpoint/CheckpointCheck 表达，交 harness CheckpointValidator 执行；SEC-01 起 command_success/command/workdir 硬拒绝，文件路径限服务端项目根 |
| `isHarnessCheck` / `HARNESS_CHECK_TYPES` | `types/gate.types.ts` | Harness 检查判断（type guard）与路由常量；HarnessCheckConfig = harness `CheckConfig` 别名 |
| 类型（ChangeLevel, CheckpointType, GatePolicy, SpecContent 等） | `types/*.ts` | 变更、门禁类型定义 |

### 依赖关系

- **上游依赖**：`@dommaker/studio-contract`（specs 域 schema）、`@dommaker/studio-shared`（logger）、`@dommaker/harness`（gate-checker 动态导入 CheckpointValidator，可选降级）、`../../core/http.js`（defineRoute/HttpError/paginated）
- **下游使用者**：`apps/api/src/route-registry.ts`（注册该路由模块）

### 注意事项

- 变更提交 API 已删除（对应 SpecChangeRequest 表已移除），但 `/changes/:changeId` 查询端点保留。
- **变更历史为进程内内存 Map（#684 决策：有意不落 FileStore）**——生产侧唯一写入口是 import 端点，analyze → validate 闭环在同进程内完成，export/import 端点即显式迁移路径；重启清空可接受。原「后续接入 Prisma」化石注释已随 Prisma 全仓删除清除。
- 门禁验证 API：POST `/changes/:changeId/validate` 调 `GateCheckerService.validate`（通用检查走 harness CheckpointValidator，studio#644），GET `/gates/:level` 与 `/gates` 查询 L1-L4 策略。
- Harness 模块采用动态导入（`await import(...)`）以避免循环依赖，失败时降级：L1/L2 非严格模式跳过、L3/L4 或严格模式判失败（降级语义见 `__tests__/gate-checker.degradation.test.ts`）。
- 通用检查不再自建构造/分发层（studio#644）：检查项即 harness `CheckpointCheck`（`config` 为 harness `CheckConfig`），上下文为 harness `CheckpointContext`（`projectPath`/`workdir`）。
- harness 4.0.0 适配（CheckConfig 判别联合化）+ SEC-01：入站由契约层 `validateChangeBodySchema` 按 type 校验必填字段（file_exists→path、file_contains→path+content、output_matches→pattern，缺了 400 点名）；command_success 整类拒绝。服务层 `buildHarnessCheck` 防御性再断一次，缺字段抛错走 catch 判失败——不再 `|| ''` 静默兜底。
- 类型定义中 `SpecContent` 没有定义所有字段（如 `api.schemas` 中的具体 schema 结构），需保持与解析器对齐。
- 所有端点需统一处理错误并记录日志。
- **鉴权（2026-07-24 收紧；P2-e 声明式统一）**：拆 open（读 + analyze-change，registry 挂 auth）/ write（POST /changes/:changeId/validate（可触发 harness 检查点执行）、POST /:id/changes/import，registry 挂 authNotGuest）双 router，路由内零鉴权挂载。
- **契约驱动（2026-10 批次 3/7）**：全部端点走 core/http.ts defineRoute（契约 packages/studio-contract/src/specs.ts，wire 形状在契约侧重声明不 import——消重归 #685 contract 解三角）。oldVersion/newVersion/import data 手写 guard 收进 zod（BAD_REQUEST）；GET /gates/:level 非法 level 原 200 空体边缘收紧为 zod 400；GET /:id/changes 分页壳形状不变（sendPaginated ≡ `{ data, pagination }`）；export 附件下载 handler 自写 res 不进壳；无前端消费方。
- **SEC-01 已关闭 Spec HTTP → Shell 旁路（2026-10-26）**：契约与 GateChecker 双层硬拒绝 `command_success`、任意 `harness.command` 和调用方 `workdir`，不依赖 role/authorType；`file_exists/file_contains` 经 core/host-execution-policy 限定服务端 `process.cwd()` 项目根并校验符号链接真实目标，越界时不调用 Harness。`output_matches` 仅允许非命令输入。回归：`gate-checker-security.test.ts` + `specs-security.routes.test.ts`。
