# triggers

> 此文件描述 apps/api/src/modules/triggers 目录的职责和上下文

## 职责

Trigger 子系统（AS-026，3.28c-4）：SCHEDULE（cron）+ EVENT（EventBus）两类条件的触发器调度与持久化，动作包括 CREATE WorkUnit / UPDATE / EXECUTE。系统默认 trigger 定义在 agents/default-triggers.ts。

## 核心导出

- `trigger.types.ts` — Trigger 类型定义（SCHEDULE + EVENT 判别联合）
- `cron-matcher.ts` — 最小 cron 表达式求值器
- `trigger-store.ts` — YAML 持久化
- `trigger-scheduler.ts` — SCHEDULE tick + EVENT EventBus 订阅
- `trigger-registry.ts` — 单例 TriggerScheduler（注入 eventBus）
- `trigger-action.ts` — CREATE 动作执行（从 trigger payload 创建 WorkUnit）
- `trigger.routes.ts` — Trigger 管理 REST API

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、workunit 模块
- 下游：agents 模块（default-triggers 注册）、apps/api 路由挂载

## 注意事项

- EVENT 类型由 PMO-Channel-Agent-Flow SDD AC-1 重新引入；旧 subscribeEvent API 已删除
- 默认 trigger 清单变更需同步 agents/__tests__/default-triggers.test.ts 与 triggers/__tests__/trigger-cleanup.test.ts
