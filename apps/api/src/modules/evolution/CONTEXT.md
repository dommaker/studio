# evolution

> 此文件描述 apps/api/src/modules/evolution 目录的职责和上下文

## 职责

E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness 约束配置。

## 核心导出

- `signals.ts` — 路径解析 + 信号加载（traces/outcomes）
- `generator.ts` — 提案生成器（信号 → 约束提案）
- `channel-review.ts` — 频道审核（提案卡片 → 人确认），卡片交互模式被其他频道确认流复用
- `applier.ts` — 提案生效器（审核通过后写入约束配置；iron-law/guideline diff 含 amend/shadow/extend_exceptions/new-entry/retire——retire 在既有 custom 条目内落 retired 元数据段，#82 D6 一处真相，内置退役不走 E1）
- `evolution.service.ts` — 聚合服务（扫描 → 生成 → 审核 → 生效编排）
- `evolution.routes.ts` — E1 约束进化 API

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore、logger）、channels 模块（审核卡片消息）
- 下游：apps/api 路由挂载；`evolution-daily-scan` trigger（agents/default-triggers）驱动每日扫描

## 注意事项

- 保守策略：信号不足时零提案；`EVOLUTION_ENABLED=false` 可整体关闭
- **harness 0.17.1 适配（2026-08-09，ADR-0001）**：E1 完整保留仅拆弹——generator (a) autoEvolve 链路挂起（report 数据层未从包 exports 导出，修复立项见 docs/plans/2026-08-flywheel-repair-e1.md），applier 写入 PROMPTS 桶（TIPS 已退役）；存量 source='harness-autoEvolve' 提案仅为兼容保留。harness 侧 /evolve /degrade /schedule 端点已删除（见 harness 模块 CONTEXT.md）
- 提案必须经人确认后才由 applier 生效，不做自动落地
- **鉴权（2026-07-24 收紧）**：`/api/v1/evolution` 挂载级 `requireAuth()+requireAdmin()` —— approve/reject/run 直接让约束变更生效，此前仅 requireAuth。
