# requirements

> 此文件描述 apps/api/src/modules/requirements 目录的职责和上下文

## 职责

REQ 需求编号体系（vision §5.3）：一个需求（`REQ-<序号>`）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。

## 核心导出

- `requirement.service.ts` — Requirement Service（REQ CRUD 与编号分配；B3a: projectId 挂接 PMO 项目，创建/更新校验项目存在）
- `requirement.routes.ts` — Requirement API 路由
- `req-binding.ts` — REQ 绑定解析，@mention 派发 / convert-to-task 共用
- `ownership-resolver.ts` — B3a 工程归属解析（决策 D2）：显式 workspaceId > Requirement.projectId → PMO gitRepo > 频道默认 > none
- `rollup.ts` — REQ 状态汇总：订阅 `workunit.status_changed` 事件回写需求整体状态

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块事件、pmo（projectService 项目存在性校验 / gitRepo 查询）
- 下游：channels（@mention 派发、convert-to-task）、pmo（progress-rollup 进度回写）、apps/api 路由挂载、apps/web 需求页

## 注意事项

- 首次 @mention 派发时自动分配 REQ 编号
- 状态汇总走事件驱动（`workunit.status_changed`），不做轮询
- **鉴权（2026-07-24 收紧）**：POST /、PATCH /:id 已收 requireAuth+requireNotGuest；GET 端点保持大门层鉴权不变。
- **B3a（决策 D2）**：Requirement 增 projectId 字段挂 PMO 项目（工程归属锚点）；studio-shared 的 RequirementData 暂未加该字段（本批改动限 apps/api/src），由本地 `RequirementWithProject` 扩展类型承载，FileStore 透传 JSON 运行时无差异。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: B3a 工程归属链（决策 D2）— Requirement 增 projectId 挂接 PMO 项目（创建/更新校验存在，路由 POST/PATCH 暴露）；新增 ownership-resolver.ts（显式 > Requirement→PMO gitRepo > 频道默认 > none，各步容错）
- ✅ 2026-07-24: 写端点收 requireAuth+requireNotGuest
