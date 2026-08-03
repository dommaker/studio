# requirements

> 此文件描述 apps/api/src/modules/requirements 目录的职责和上下文

## 职责

REQ 需求编号体系（vision §5.3）：一个需求（`REQ-<序号>`）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。

PMO-a 别名层（2026-07-28 分析文档，决策 4）：REQ 退化为 PMO 的只读别名——get/list 先查统一编号 PMO（reqAlias 命中 → 投影为 REQ 视图，projectId = PMO 自身 id），查不到才回落 legacy REQ 记录；update/maybeRollUpToDone 对别名视图只读跳过（PMO 状态由 pmo/progress-rollup 拥有）。新代码只见 PMO；下个大版本删别名层。

## 核心导出

- `requirement.service.ts` — Requirement Service（REQ CRUD 与编号分配；B3a: projectId 挂接 PMO 项目；决策 4 别名层 get/list/update/getChain 别名感知；决策 2 createFromDispatch 杂务归集——频道已登记杂务 PMO 时小活归集其 REQ 别名，只查不建）
- `requirement.routes.ts` — Requirement API 路由
- `req-binding.ts` — REQ 绑定解析（显式 reqId > #REQ-XXXX token > #PMO-n/#PM-n token（决策 4 别名层解析，无别名存量拒绝歧义降级）> 自动新建），@mention 派发 / convert-to-task 共用
- `ownership-resolver.ts` — B3a 工程归属解析（决策 D2）：显式 workspaceId > Requirement.projectId → PMO gitRepo > 频道默认 > none
- `pmo-branch-resolver.ts` — PMO-b（决策 3）：WU → PMO 分支解析（metadata.ownershipProjectId > reqId→REQ→PMO；branch = gitBranch || pmoNumber，透出 deliveryPolicy），agent-loop worktree base 与 merge-on-review-pass 的目标分支来源；`resolvePmoProjectIdForWU`（2026-07 PMO-flow UX §6）：同链序只出项目 id（补第 ③ 级 metadata.pmoProjectId，项目存在校验逐级容错），monitoring /agents 聚合（map 版 deps 批量内存匹配）与里程碑消息 meta.pmoId（agent-loop/ReviewDispatcher/timeout-release/merge-on-review-pass）共用
- `rollup.ts` — REQ 状态汇总：订阅 `workunit.status_changed` 事件回写需求整体状态（别名视图跳过，PMO 侧 progress-rollup 拥有）

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块事件、pmo（projectService 项目存在性校验 / gitRepo 查询 / 别名扫描 / 杂务 find-or-create）
- 下游：channels（@mention 派发、convert-to-task）、pmo（progress-rollup 进度回写）、agents（agent-loop 经 pmo-branch-resolver 决定 worktree base）、apps/api 路由挂载、apps/web 需求页

## 注意事项

- 首次 @mention 派发时自动分配 REQ 编号（频道已登记杂务 PMO 时归集到杂务别名，不再每条消息新建 REQ）
- 状态汇总走事件驱动（`workunit.status_changed`），不做轮询
- **鉴权（2026-07-24 收紧）**：POST /、PATCH /:id 已收 requireAuth+requireNotGuest；GET 端点保持大门层鉴权不变。
- **B3a（决策 D2）**：Requirement 增 projectId 字段挂 PMO 项目（工程归属锚点）；studio-shared 的 RequirementData 暂未加该字段（本批改动限 apps/api/src），由本地 `RequirementWithProject` 扩展类型承载，FileStore 透传 JSON 运行时无差异。
- **决策 4（别名层）**：别名视图 createdBy='pmo-alias' 只读；`RequirementServiceDeps` 可注入 getProjectByAlias/findChoreProject/listAliasProjects/getProjectByPmoNumber——单测务必注入中性桩（默认实现读真实 ~/.studio/projects，并行测试会被 routes 测试的真实项目串扰）。
