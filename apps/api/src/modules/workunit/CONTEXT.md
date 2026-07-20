# workunit

> 此文件描述 apps/api/src/modules/workunit 目录的职责和上下文

## 职责

WorkUnit 核心域（AS-025 §3.28c-1, §5.16）：任务单元的 CRUD、认领（Claim）与状态机；F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。

## 核心导出

- `workunit.service.ts` — WorkUnit Service：CRUD + Claim + 状态机，`create()` 发布 `workunit.created` 事件
- `workunit.routes.ts` — WorkUnit API 路由
- `waiting-input.ts` — F5 双向沟通：NEED_INPUT 挂起 WorkUnit 的恢复与超时提醒

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）
- 下游：agents（AgentLoop 认领执行）、requirements（状态汇总）、channels（@mention 派发）、triggers（CREATE 动作）

## 注意事项

- 状态变更发布 `workunit.status_changed` 事件，requirements/rollup 据此汇总 REQ 状态
- NEED_INPUT 挂起后由人在频道线程回复触发续跑
