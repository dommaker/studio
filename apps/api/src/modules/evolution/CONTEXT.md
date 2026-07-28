# evolution

> 此文件描述 apps/api/src/modules/evolution 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/evolution/CONTEXT.md, apps/api/src/modules/evolution/signals.ts, apps/api/src/modules/evolution/applier.ts, apps/api/src/modules/evolution/channel-review.ts, apps/api/src/modules/evolution/evolution.routes.ts, apps/api/src/modules/evolution/evolution.service.ts, apps/api/src/modules/evolution/generator.ts

## 职责

E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness 约束配置。

## 核心导出

- `signals.ts` — 路径解析 + 信号加载（traces/outcomes）
- `generator.ts` — 提案生成器（信号 → 约束提案）
- `channel-review.ts` — 频道审核（提案卡片 → 人确认），卡片交互模式被其他频道确认流复用
- `applier.ts` — 提案生效器（审核通过后写入约束配置）
- `evolution.service.ts` — 聚合服务（扫描 → 生成 → 审核 → 生效编排）
- `evolution.routes.ts` — E1 约束进化 API

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore、logger）、channels 模块（审核卡片消息）
- 下游：apps/api 路由挂载；`evolution-daily-scan` trigger（agents/default-triggers）驱动每日扫描

## 注意事项

- 保守策略：信号不足时零提案；`EVOLUTION_ENABLED=false` 可整体关闭
- 提案必须经人确认后才由 applier 生效，不做自动落地
- **鉴权（2026-07-24 收紧）**：`/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()` —— approve/reject/run 直接让约束变更生效，此前仅 requireAuth。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ 2026-07-27: B5 D18 — signals 的 tool:call 信号改读 studioEventsFile（统一事件文件；兼容 payload 嵌套与历史扁平形态），eventsDir 字段保留但标记 deprecated
- ✅ 2026-07-27: P0 修复 5 — signals 的 studioEventsFile 默认路径走 utils/studio-log-path 测试隔离（overrides 优先不变，生产行为不变）
- ✅ 2026-07-24: API 鉴权收紧 — 挂载收 requireAuth+requireAdmin（约束审批 = 治理面）
