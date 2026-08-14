# triggers

> 此文件描述 apps/api/src/modules/triggers 目录的职责和上下文

## 职责

Trigger 子系统（AS-026，3.28c-4）：SCHEDULE（cron）+ EVENT（EventBus）两类条件的触发器调度与持久化，动作包括 CREATE WorkUnit / UPDATE / EXECUTE。系统默认 trigger 定义在 agents/default-triggers.ts（配置真相源 = 代码注册块，`getDefaultTriggerConfigs()` 已随 #102 删除，测试从 `TriggerScheduler.getStates()` 取数）。

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
- 默认 trigger 清单变更需同步 agents/__tests__/default-triggers.test.ts 与 triggers/__tests__/trigger-cleanup.test.ts（两者均从 `TriggerScheduler.getStates()` 注册块取数，不再读 `getDefaultTriggerConfigs()`）
- **#102 触发器五删（2026-08-14）**：`knowledge-quality-audit`（闸口移写时两档人审）、`session-knowledge-extraction`（收尾钩子替代）、`zero-consumption-audit`（读率降格为 GC 打分输入）、`knowledge-synthesis`（蒸馏职能移交 #83）四者从代码注册块删除；`daily-health-check` LLM 形态数据区 yaml 删除，监控面归 agents/monitor/monitor-system-probes.ts 确定性探针。保留 6 个：workunit-timeout / agent-timeout / okr-metric-sync / workunit-input-reminder / evolution-daily-scan / doc-semantic-review（enabled:false，恢复归 #103）
- **鉴权（2026-07-24 收紧）**：`/api/v1/triggers` 挂载级 `requireAuth()+requireAdmin()` —— POST/DELETE 会热加载触发器直接驱动 AgentLoop 执行。另：`GET /status` 注册在 `GET /:id` 之后被遮蔽（历史 bug，未修）。
