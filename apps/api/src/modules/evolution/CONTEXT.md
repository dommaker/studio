# evolution

> 此文件描述 apps/api/src/modules/evolution 目录的职责和上下文

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
