# 03 — Studio 全量重构死代码盘点

> 排查范围：`apps/` + `packages/` + `scripts/` + `tests/`（排除 node_modules / dist / .git / 构建产物）
> 方法：脚本化全量符号提取 + 逐符号 grep 交叉验证（含动态 import、字符串路由注册、postcss/vitest 配置字符串），二次确认 pass 区分「完全零引用 / 仅测试引用 / 仅模块内部使用 / 疑似死 import」。
> 扫描器局限（影响置信度标注）：
> 1. 同名符号碰撞会导致**漏报**（例：`detectAnomalies` 在 pmo 与 harness 两处同名，pmo 侧死代码未被自动捕到，系人工补查发现）。
> 2. 二次确认 pass 未排除 `packages/*/dist/*.d.ts`，dist 镜像声明会把个别「完全零引用」顶入「内部使用」档——即 DEAD-TOTAL 清单是**保守**的，真实零引用只会更多。
> 3. IMPORT-DEAD 档含注释命中与 dist 命中，已抽查 7 例（3 例属实、4 例为注释/dist 噪音），整档标「疑似」。

统计总览（导出符号级）：

| 范围 | 导出符号总数 | DEAD-TOTAL（确定零引用） | TEST-ONLY（仅测试引用） | SELF-ONLY（仅定义文件内部使用，export 冗余） | IMPORT-DEAD（疑似死 import） |
|---|---|---|---|---|---|
| apps/api | 829 | 35 | 22 | 294 | 13 |
| apps/web | 311 | 11 | 4 | 70 | 3 |
| packages/* | 574 | 13 | 2 | 22 | 174 |

---

## 1. 零引用导出

### 1.1 DEAD-TOTAL —— 全仓除 export 声明外无任何出现（确定）

**apps/api（35 项）**

| 符号 | 定义位置 | 建议处置 |
|---|---|---|
| `encrypt` / `decrypt` | apps/api/src/utils/crypto.ts（全文件仅这 2 个导出） | **整文件删除**。grep `utils/crypto` 全仓零 import（cli/server.ts、middleware/auth.ts 等用的是 node 内置 `crypto`） |
| `sendSuccess` / `sendBadRequest` / `sendNotFound` | apps/api/src/utils/response.ts | 删 3 个死函数（response.ts 其余导出仍在用） |
| `sendDiscordNotification` | apps/api/src/utils/discord-notifier.ts | 删；discord-notifier.ts 其余 3 个导出仍在用，保留文件 |
| `clearCache` | apps/api/src/middleware/api-cache.ts | 删 |
| `createHealthRoutes` | apps/api/src/modules/agents/ops.service.ts:629 | 删。route-registry.ts:131-147 手工另建了 healthRouter，从未调用此工厂 |
| `getRegister` / `recordApiRequest` / `recordLlmProxyRequest` / `recordTaskProcessed` / `updateTaskQueueLength` | apps/api/src/monitoring/index.ts | 删 5 个死函数；`getMetrics` 仍被 app.ts:50 使用，模块保留 |
| `startGC` / `stopGC` | apps/api/src/modules/workspaces/gc-service.ts | **整个 GC 服务从未被启动/接线**，疑似废弃功能（见 §5.10） |
| `discoveryExposure`（及同文件其余 2 个导出） | apps/api/src/modules/channels/discovery-exposure.service.ts | **整文件删除**。全仓仅 knowledge-bus.service.ts:6 注释提及 |
| `formatTriageMessage` / `routeFailure` | apps/api/src/modules/triage/error-class.ts:190,197 | 删 2 个死函数；`classifyError`/`classifySystemError` 等仍被 triage.service.ts 使用 |
| `saveRules` | apps/api/src/modules/agents/ops-rules.ts | 删（ops.service.ts 仅用同文件其他导出） |
| `saveOutput` | apps/api/src/modules/outputs/routes.ts | 删 |
| `resetEvolutionService` | apps/api/src/modules/evolution/evolution.service.ts | 删 |
| `resetSystemExecutor` | apps/api/src/modules/agents/system-executor.ts | 删 |
| `resolutionMatcher` | apps/api/src/modules/knowledge/resolution.service.ts | 删 |
| `ReviewResult` / `ReviewDiffParams` / `MergeToMasterRequest` / `MergeToMasterResult` / `MergeBranchesParams` / `MergeBranchesResult` | apps/api/src/modules/agents/types.ts | **旧 review/merge 栈类型残余**（59e3dc81 删 review 栈后遗留），整组删除 |
| `ReviewResultBlock` | apps/api/src/modules/agents/review-contract.ts | 删（review-contract 模块本身活着，此类型无消费） |
| `KnowledgeExtraction` | apps/api/src/modules/agents/types.ts | 删 |
| `ErrorResponse` / `ExecutionRequest` / `GenerateSkillsResponse` | apps/api/src/types/index.ts | 删 |
| `ProjectStatus` | apps/api/src/modules/pmo/project.service.ts | 删 |

**apps/web（11 项）**

| 符号 | 定义位置 | 建议处置 |
|---|---|---|
| `Onboarding` | components/Onboarding.tsx | **整文件删除**（零引用组件，见 §2） |
| `DeleteButton` | components/DeleteButton.tsx | 整文件删除 |
| `analyzeDiffImpact` / `buildKnowledgeGraphFromAnalysis` | components/KnowledgeGraphView.tsx | 删 2 个死导出；KnowledgeGraphView 组件本身被 WikiPage.tsx:176 使用，保留 |
| `apiPost` | utils/api.ts | 删（`apiFetch` 仅文件内部使用，建议一并去 export 化） |
| `formatTokensShort` | utils/format.ts | 删 |
| `CreateRoleInput` / `PerformanceStats` | types.ts | 删 |
| `PmoNumberLink` | components/PmoNumberBadge.tsx | 删（PmoNumberBadge 本体活着） |
| `ThemeToggle` | contexts/ThemeContext.tsx | 删（ThemeContext/Provider 活着） |
| `useStageCapabilities` | hooks/useCapabilities.ts | **整文件删除**——同文件 `useCapabilities` 也零引用（§2） |

**packages（13 项，均为公共出口但仓内无消费）**

| 符号 | 定义位置 | 建议处置 |
|---|---|---|
| `createCompanyMCPPool` 及同文件全部 10 个导出（CompanyMCPPool/CompanyMCPPoolConfig/MCPSource/MCPStatus/MCPTool/MCPTransport/MCPUsageRecord/CompanyMCP/SystemMCP） | packages/studio-capability/src/services/company-mcp-pool.ts | **整文件删除**。index.ts:6 `export *` 转发但全仓零消费 |
| `IronLawService` | packages/studio-shared/src/harness/index.ts | 删（api 侧 iron-laws 走自己的 routes，不经此 Service） |
| `StanceInjectionConfig` / `StancePromptVariables` / `StanceReviewResult` | packages/studio-shared/src/types/stance.ts | 删（stance 体系其余导出仍有消费） |
| `ExtractBehaviorInput` / `ExtractBehaviorResult` | packages/studio-shared/src/types/user-behavior.ts | 删 |
| `AcceptanceValidationInput` / `ApiValidationInput` / `ArchitectureValidationInput` | packages/studio-spec/src/types/validation.types.ts | 删 |
| `ApproveChangeInput` / `SubmitChangeInput` / `SubmitChangeResult` | packages/studio-spec/src/types/change.types.ts | 删 |

### 1.2 TEST-ONLY —— 仅测试文件引用（确定；多为「为测试而 export」或可随死功能连坐）

- apps/api 22 项：`analyzeKnowledgeSearch`、`extractKnowledgeEntryIds`（agent-loop.ts）、`apiRateLimit`（middleware/rate-limit.ts）、`checkOwnership`（auth.ts）、`checkThresholds`/`collectSystemHealth`（system-health.ts）、`classifyFailureAction`（failure-classifier.ts）、`fetchExternal`（external-fetcher.ts）、`getActiveConnectionCount`/`getConnectedWorkspaceIds`/`notifyTaskAvailable`（ws-gateway.ts）、`getDefaultTriggerConfigs`、`getSkillFilePath`、`getWorkspaceFilePath`、`handleDiscover`、`invalidateEvalCaseCache`、`invalidateTokenUsageCache`、`resetDailyTokenBudgetState`、`revokeRefreshToken`（auth/service.ts）、`setTriggerActionFileStore`、`unregisterExecuteHandler`、`validateRequirementsDoc`。
- apps/web 4 项：`ConversationActions`、`ConversationMessageList`、`DirectoryBrowser`、`ExecutionTargetSelector` —— 组件本体仅测试引用，见 §2。
- packages 2 项：`AuditorConclusion`（studio-shared auditor-types）、`Stance`（studio-shared stance.ts，仅 studio-skill 测试用）。

建议处置：逐一确认是否「测试在测死代码」。其中 `apiRateLimit` 特别注意：route-registry.ts:9 **import 了 `mcpRateLimit` 但从未 apply**（grep 全文仅 1 处 import 行），`apiRateLimit` 连 import 都没有——rate-limit.ts 里 4 个 limiter 实例实际接线情况需随鉴权中间件重构一并复核。

### 1.3 SELF-ONLY（386 项）与 IMPORT-DEAD（190 项）

- SELF-ONLY：符号仅在其定义文件内部使用，`export` 修饰符冗余。不是死代码，但重构时可批量去 export 化收窄公共面，优先级低。
- IMPORT-DEAD：疑似「被 import 但从未使用」。抽查 7 例：`mcpRateLimit`（route-registry.ts:9，**属实**）、`hasUncommittedChanges`/`readHeadHash`/`signalAggregator`/`SkillStore`（均为注释命中，误报）、`TaskExecutor`/`SpawnArgs`（dist/*.d.ts 命中，误报）。整档标**疑似**，重构时建议用 `tsc --noUnusedLocals` 或 knip 复扫。

---

## 2. 零引用前端资产

扫描口径：对 apps/web/src 的 components/pages/hooks/stores/utils/contexts 逐文件取文件名片段，全仓（apps+packages+scripts+tests）grep；以下文件除自身与同名测试外零命中。

### 2.1 零引用组件（确定，14 个）

| 组件文件 | 测试文件 | 备注 |
|---|---|---|
| components/ReviewPanel.tsx | 无 | **旧 review 栈前端残余**（ intents 审核确认面板），零 import |
| components/MultiStanceReviewPanel.tsx | 无 | 旧多立场评审栈；仅被 ReviewOpinionCard import |
| components/ReviewOpinionCard.tsx | 无 | 仅被上述死组件引用，封闭死簇 |
| components/StanceBadge.tsx | 无 | 仅被 ReviewOpinionCard 引用，封闭死簇 |
| components/IntentResult.tsx | 无 | 还 import 了 styles/theme.css |
| components/SpeakingQueuePanel.tsx | 无 | 会议/发言队列残余 |
| components/Onboarding.tsx | 无 | |
| components/DeleteButton.tsx | 无 | |
| components/FilePreview.tsx | 无 | |
| components/IronLawsSection.tsx | 无 | IronLawWarningBanner 活着，此 Section 死 |
| components/TaskCard.tsx | __tests__/TaskCard.test.tsx | b31f8fc2 删老 Task UI 后残余 |
| components/CheckpointTimeline.tsx | __tests__/CheckpointTimeline.test.tsx | df0cc269 收编 EvidenceLedger 后残余 |
| components/DirectoryBrowser.tsx | __tests__/DirectoryBrowser.test.tsx | 仅测试引用 |
| components/ConversationMessageList.tsx | __tests__/ConversationMessageList.test.tsx | 仅测试引用 |
| components/ConversationActions.tsx | __tests__/ConversationActions.test.tsx | 仅测试引用 |
| components/IronLawAlert.tsx | __tests__/IronLawAlert.test.tsx | 仅测试引用 |
| components/ExecutionTargetSelector.tsx | __tests__/ExecutionTargetSelector.test.tsx | 仅测试引用 |

（其中后 6 个为「组件 + 测试」双向孤儿。）

### 2.2 其他零引用资产（确定）

- hooks/useCapabilities.ts —— 整个 hook 文件零引用（`useCapabilities` 仅文件内自引用，`useStageCapabilities` 零引用）。
- styles/animations.css、styles/mission-control.css —— 全仓零 import（index.css 只 `@import` 了 tailwindcss 与 responsive.css；theme.css 仍有 import，但其中 2 个 import 方 IntentResult/CheckpointTimeline 本身是死组件）。
- assets/hero.png、assets/react.svg、assets/vite.svg —— 零引用（vite 脚手架遗留）。
- pages/design-lab/ —— 有路由无导航入口，整体属「候选废弃功能」，见 §5.1。

---

## 3. 冗余依赖

### 3.1 确定冗余（源码 + 脚本 + 配置全形态零引用）

| 包 | 声明位置 | 证据 |
|---|---|---|
| `multer` + `@types/multer` | apps/api dependencies/devDependencies | 全仓 grep 零命中 |
| `undici` | apps/api dependencies | 全仓 grep 零命中（疑似，若有运行时动态 require 需复核） |
| `ioredis` | packages/studio-task dependencies | 仅出现在 evolution 测试的约束文案字符串「禁止引入 Redis/ioredis 依赖」中 |
| `zod` | studio-agent / studio-capability / studio-monitor / studio-spec 四个包 dependencies | 全仓 grep 零命中（4 处声明） |
| `@types/react-router-dom` | apps/web dependencies | react-router-dom v7 自带类型，零 import |

### 3.2 疑似冗余（类型 stub，目标库已自带类型声明）

- apps/api：`@types/compression`、`@types/express-rate-limit`（express-rate-limit v8 自带类型）、`@types/js-yaml`（js-yaml v4 自带类型）、`@types/pino`（pino v10 自带类型）。建议删后跑 typecheck 验证。

### 3.3 声明错位 / 配置失效（非冗余但需处置）

- `node-fetch`：声明在 apps/api，但实际 import 在 packages/studio-task/src/services/task-worker.ts:13（靠 pnpm hoist 侥幸可解析，且带 `@ts-ignore`）。应移到 studio-task 或消除该 import。
- apps/web devDependencies 的 eslint 工具链（`eslint`、`@eslint/js`、`typescript-eslint`、`eslint-plugin-react-hooks`、`eslint-plugin-react-refresh`、`globals`）：apps/web 下**不存在 eslint.config.\***，全仓仅根目录一个 legacy `.eslintrc.cjs`（引用未声明的 `@typescript-eslint/parser`）。eslint v9 无 flat config 直接跑 `eslint .` 会失败——`apps/web` 的 `lint` 脚本当前实际不可用，整套依赖要么补配置要么删。
- 误判排除（确认在用）：`dotenv`（apps/api/src/index.ts:2 `import 'dotenv/config'`）、`pino-pretty`（utils/logger.ts:7 transport target 字符串）、`@tailwindcss/postcss`/`autoprefixer`/`postcss`/`tailwindcss`（apps/web/postcss.config.js）、`@testing-library/jest-dom`（src/test/setup.ts:1）、`playwright`（apps/web/e2e/*.spec.ts）。

---

## 4. 注释尸体

### 4.1 大段注释代码块（≥10 行）

- **未发现**。脚本扫描 `//` 连续块与 `/* */` 块（≥10 行且 ≥40-60% 行呈代码特征），apps/packages/scripts/tests 均为 0 命中。仓库注释卫生良好（近期重构已清理）。

### 4.2 过时/废弃标记注释（需随代码处置）

| 位置 | 内容 | 处置建议 |
|---|---|---|
| apps/api/src/app.ts:44 | 「G5: 模型路由历史（Pipeline 已废弃，保留端点返回空）」 | 端点本身即废弃功能，见 §5.6 |
| apps/api/src/index.ts:412 | 「Deprecated meeting services removed from startup — stops are no-ops」 | 注释下方 `stopHealthMonitor()` 调用即为 no-op，见 §5.4 |
| apps/api/src/index.ts:13-15,414-415 | 「默认关闭（启动/停止由 STUDIO_TASK_QUEUE_ENABLED=true 恢复）」 | 见 §5.3 |
| apps/api/src/modules/workunit/workunit.service.ts:55,64 | `ownershipProjectId`「@deprecated legacy 同位名，仅读兼容」；「@deprecated 2026-08 归因统一」 | 兼容读取字段，重构时随 wu-metadata 口径统一决定是否清除 |
| apps/api/src/modules/channels/migrate-members.ts:5 | 「（deprecated，只读不删）」 | 迁移脚本，可归档到 scripts/_archive |
| apps/api/src/modules/skills/* 多处 `_deprecated` | skill 生命周期术语（published→deprecated），属业务语义 | 非尸体，不动 |
| README.md:129 | 「STUDIO_TASK_QUEUE_ENABLED：pipeline 时代遗留任务队列，默认关（无存活生产者）」 | 官方背书 §5.3 为废弃功能 |

---

## 5. 候选废弃功能（完整调用链证据）

### 5.1 pages/design-lab/ 原型实验区（疑似 → 倾向废弃）

- 文件：DesignLabPage.tsx、DirectionAPage.tsx、DirectionBPage.tsx、PrototypeShell.tsx、mock-data.ts、design-lab.css + 3 个测试文件。
- 入口链：App.tsx:30-32 lazy import → App.tsx:130-132 注册 `/design-lab`、`/design-lab/a`、`/design-lab/b` 三条路由。
- **断点**：全仓导航零入口——SidebarNew.tsx 导航项（pmo/wiki 等）无 `/design-lab`；全仓 `<Link to="/design-lab">` 仅存在于 design-lab 内部互链（DesignLabPage.tsx:15,28、PrototypeShell.tsx:301）。用户只能靠手敲 URL 到达。
- 数据链：全部渲染 mock-data.ts 静态数据，零 API 调用。
- 结论：路由在、导航断、数据假。疑似设计稿预览残留。**建议整目录删除或明确保留为设计沙箱**。

### 5.2 前端旧 review 栈组件簇（确定）

- ReviewPanel / MultiStanceReviewPanel / ReviewOpinionCard / StanceBadge 四文件封闭互引，对外零引用（§2.1 证据）。与 59e3dc81「删除旧 review 栈」同源的前端残余。
- 服务端对应残余：agents/types.ts 的 `ReviewResult`/`ReviewDiffParams`/`MergeToMaster*`/`MergeBranches*` 类型（§1.1）。

### 5.3 studio-task 任务队列（STUDIO_TASK_QUEUE_ENABLED 门控，确定废弃）

- 门控：apps/api/src/index.ts:415 `process.env.STUDIO_TASK_QUEUE_ENABLED === 'true'` 才执行 stop/close；**启动侧代码已不存在**（grep `taskWorker.start` 零命中）。
- README.md:129 明示：「pipeline 时代遗留任务队列，默认关（无存活生产者）」。
- 消费端：仅剩 apps/api/src/modules/executions/routes.ts:225 `GET /executions/worker/status` 调 `taskWorker.getStatus()`——该端点前端零调用（§5.7）。
- 连带：studio-task 包内 task-worker/task-queue 及 runClean/runQueue/runRetry/runRun 等 CLI 导出均零消费；`ioredis` 依赖（§3.1）；`node-fetch` 错位 import（§3.3）。

### 5.4 studio-monitor 健康监控（确定废弃）

- 证据：apps/api/src/index.ts:15 import `startHealthMonitor, stopHealthMonitor`；全仓 `startHealthMonitor` **从未被调用**；index.ts:413 仅在关停钩子里 `stopHealthMonitor()`（no-op，注释自承「stops are no-ops」）。
- studio-monitor 包 6 个导出符号中 5 个零引用，唯一被引用的就是上面这个 no-op stop。**整个包可随 shutdown 钩子一起移除**，apps/api package.json 依赖同步删。

### 5.5 spec-reviews 模块（无前端调用方，确定）

- 注册：route-registry.ts:223 `{ path: '/api/v1/spec-reviews', router: specReviewRoutes, middleware: auth }`。
- 前端：apps/web/src 全量 grep `spec-reviews`/`specReview` **零命中**（仅 scripts/_archive 迁移脚本提及）。
- 模块文件：apps/api/src/modules/spec-reviews/{routes.ts, spec-review.service.ts} + 死类型 `ApprovalInput`/`CreateReviewInput`（§1.1）。无测试。
- 注意：前端 SpecificationReview 类 UI 已不在仓内，此端点集对外无消费方。

### 5.6 `GET /metrics/routing` 空端点（确定）

- app.ts:44-46，注释自承「Pipeline 已废弃，保留端点返回空」，固定返回 `{ data: [], total: 0 }`。前端零调用。建议直接删端点。

### 5.7 `GET /executions/worker/status`（确定）

- executions/routes.ts:223。前端 api 层无任何 `worker/status` 调用（apps/web/src/api 全目录 grep 零命中）。且其数据源 taskWorker 永不启动（§5.3），返回值恒为 stopped。随任务队列一并删除。

### 5.8 `POST /executions/:executionId/archive`（确定）

- executions/routes.ts:240。前端 archive 相关调用全部指向 `/knowledge/:id/archive`（api/knowledge.ts:68-69），无 `executions.*archive` 调用。executions 路由其余端点（GET /、POST /events、GET /:id、POST /）仍被 runtimeWorkflowApi/PMOCard/runtimeStore 消费，**仅删此端点**。

### 5.9 PMO OKR 子链路：两个无调用端点 + 一个孤儿检测器（确定）

- 活链确认：PMOPage.tsx / PMOCard.tsx → api/pmo.ts `okrApi.list/create` → routes.ts `GET/POST /api/v1/pmo/okr`。**OKR 主功能活着，不要误删**。
- 死链 1：`GET /pmo/okr/metrics`（routes.ts:406，`okrService.getMetricBaseline`）——前端零调用。
- 死链 2：`GET /pmo/okr/data-health`（routes.ts:443，`okrService.checkDataSourceHealth`）——前端零调用。
- 孤儿：apps/api/src/modules/pmo/okr-anomaly-detector.ts（`detectAnomalies`）——全仓消费方仅其自身测试 `__tests__/okr-anomaly-detector.test.ts`（自动扫描因与 harness 模块同名函数碰撞漏报，人工补查确认）。

### 5.10 workspaces GC 服务（确定）

- apps/api/src/modules/workspaces/gc-service.ts 的 `startGC`/`stopGC` 全仓零调用（§1.1），服务从未接线。整文件删除。

### 5.11 知识图谱链路核查结论（活，勿删）

- KnowledgeGraphView.tsx ← WikiPage.tsx:11,176（`graph={graphData}`）← App.tsx 路由 `/wiki` ← SidebarNew.tsx:21 导航项。**链路完整存活**；`@xyflow/react` 依赖仅此一处消费，若未来删 KnowledgeGraphView 需连带回笼该依赖。组件内死导出 `analyzeDiffImpact`/`buildKnowledgeGraphFromAnalysis` 可单独删。

### 5.12 特性开关排查补充

- 全仓仅发现 `STUDIO_TASK_QUEUE_ENABLED` 一个默认关闭特性开关（§5.3）。无其他「配置默认关闭且从未启用」的 flag。

---

## 6. 连带孤立死代码提示

| 若移除…… | 将连带变成孤儿（或本就是孤儿、应一并删） |
|---|---|
| **design-lab 目录**（§5.1） | pages/design-lab/__tests__/ 3 个测试文件、design-lab.css、mock-data.ts 全部导出（LabAgent/LabChannel/LabDirection/LabTokenStat/CardStatus/CardType/AgentStatus/labWorkUnits 均 SELF-ONLY）、App.tsx:30-32 lazy import 与 125-132 路由分支 |
| **前端 review 簇**（§5.2） | ReviewOpinionCard → StanceBadge、MultiStanceReviewPanel 内 `ReviewOpinion`/`MultiStanceReview` 类型；服务端 agents/types.ts 6 个 merge/review 类型、review-contract.ts `ReviewResultBlock` |
| **任务队列**（§5.3） | packages/studio-task 的 task-worker.ts/task-queue.ts、`ioredis` 依赖、apps/api 对 @dommaker/studio-task 的依赖声明、monitoring/index.ts `updateTaskQueueLength`/`recordTaskProcessed`（已死）、`taskQueueLength` Gauge（src/monitoring/index.ts:29）、README.md:129 文档行、`STUDIO_TASK_QUEUE_ENABLED` 关停分支（index.ts:414-419）、`/executions/worker/status` 端点（§5.7） |
| **studio-monitor 包**（§5.4） | apps/api package.json 中 `@dommaker/studio-monitor` 依赖、index.ts:15 import 与 :413 no-op 调用 |
| **spec-reviews 模块**（§5.5） | route-registry.ts:47,223 注册行、`ApprovalInput`/`CreateReviewInput` 死类型、scripts/_archive/migrate-spec3-to-files.ts 中 specReviews 段（已归档，可不动） |
| **`/metrics/routing` 端点**（§5.6） | app.ts:44 注释一并删 |
| **OKR 死端点 ×2**（§5.9） | okr.service.ts 中 `getMetricBaseline`/`checkDataSourceHealth` 方法（端点删除后转 SELF-ONLY/零引用，需复扫）、okr-anomaly-detector.ts 及其测试 |
| **GC 服务**（§5.10） | gc-service.ts 整文件，无其他连带 |
| **零引用组件 14 个**（§2.1） | 各自 __tests__ 测试文件（7 个）；IntentResult/CheckpointTimeline 删除后 theme.css 的 import 方减少（theme.css 本体仍有 PMOCard 等活引用，保留）；components/knowledge、components/pmo、components/requirement、components/setup、components/workunit、components/channel、components/ui 子目录均已核实有活引用，**不受连带** |
| **useCapabilities.ts**（§2.2） | 无连带（无测试文件） |
| **utils/crypto.ts**（§1.1） | 整文件删除后无连带 |
| **discovery-exposure.service.ts**（§1.1） | 删除后 knowledge-bus.service.ts:6 注释需同步更新 |
| **冗余依赖**（§3） | 删 `multer`/`@types/multer`、`undici`、`ioredis`、`zod`×4、`@types/react-router-dom` 后跑 typecheck + 全量测试验证；eslint 工具链需先决策「补 flat config 还是删 lint 脚本」 |

---

## 附：复扫建议

1. 本报告 DEAD-TOTAL 档可直接进入删除评审；TEST-ONLY 档需先确认测试意图；SELF-ONLY/IMPORT-DEAD 档建议重构后用 knip 或 `tsc --noUnusedLocals` 复扫收敛。
2. 同名符号碰撞导致漏报（§5.9 okr-anomaly-detector 为例），删除轮次结束后应对剩余导出再跑一轮复扫。
3. 所有「确定」项的证据均为 grep 全仓零命中 + 人工读文件确认调用链；「疑似」项已在文中逐一标注理由。
