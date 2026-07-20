# requirements

> 此文件描述 apps/api/src/modules/requirements 目录的职责和上下文

## 职责

REQ 需求编号体系（vision §5.3）：一个需求（`REQ-<序号>`）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。

## 核心导出

- `requirement.service.ts` — Requirement Service（REQ CRUD 与编号分配）
- `requirement.routes.ts` — Requirement API 路由
- `req-binding.ts` — REQ 绑定解析，@mention 派发 / convert-to-task 共用
- `rollup.ts` — REQ 状态汇总：订阅 `workunit.status_changed` 事件回写需求整体状态

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块事件
- 下游：channels（@mention 派发、convert-to-task）、apps/api 路由挂载、apps/web 需求页

## 注意事项

- 首次 @mention 派发时自动分配 REQ 编号
- 状态汇总走事件驱动（`workunit.status_changed`），不做轮询
