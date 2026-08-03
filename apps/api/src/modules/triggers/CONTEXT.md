# triggers

> 此文件描述 apps/api/src/modules/triggers 目录的职责和上下文

<!-- STALE_SINCE: 2026-08-03 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/triggers/CONTEXT.md, apps/api/src/modules/triggers/trigger-action.ts, apps/api/src/modules/triggers/trigger-registry.ts, apps/api/src/modules/triggers/trigger-scheduler.ts, apps/api/src/modules/triggers/trigger.types.ts

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
- **鉴权（2026-07-24 收紧）**：`/api/v1/triggers` 挂载级 `requireAuth()+requireAdmin()` —— POST/DELETE 会热加载触发器直接驱动 AgentLoop 执行。另：`GET /status` 注册在 `GET /:id` 之后被遮蔽（历史 bug，未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-08-03: B3 触发器幂等（token-burn issue，修 8/1 同分钟双触发）— tick() 增同分钟守卫（lastFiredAt 落在当前触发分钟内则跳过，cron 分钟粒度）；executeCreateAction 增 `dedupeWithinMinute` 选项：SCHEDULE 触发按「同 triggerId 同分钟已有 WU（metadata.triggerId+triggeredAt）」落盘去重返回 null（跨进程/重启兜底，in-memory 守卫挡不住的情形）；EVENT 触发不去重
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ 2026-07-27: P0 触发器修复 — executeUpdateAction 查询支持 { lt, gt, lte, gte }（ISO 时间/数值）+ '$now' 占位符执行时刻求值；workunit-timeout 由 UPDATE 改为 EXECUTE（handler 在 workunit/timeout-release.ts）
- ✅ 2026-07-24: API 鉴权收紧 — 挂载收 requireAuth+requireAdmin（触发器写操作 = 远程执行面）
