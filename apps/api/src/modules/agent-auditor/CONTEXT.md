# apps/api/src/modules/agent-auditor

### 职责

Auditor Agent（P2-d 刀4 自 modules/agents/auditor 提升为顶层模块）：24h 日审跨任务审计——错误归类/技能建议/知识健康 → 低风险自动应用 / 人审确认卡片 / Resolution / Triage 升级。由 bootstrap/services 启动链装配（monitor → auditor → …）。

### 目录结构

- `auditor.service.ts` — 门面，24h 日审调度
- `auditor-rules.ts` — 检测规则（错误归类/技能建议/知识健康）
- `auditor-execution.ts` — 建议执行（低风险自动应用/确认卡片/Resolution/Triage 升级）
- `auditor-reports.ts` — 行为趋势/七日趋势/tier 反馈
- `review-adapter.ts` — auditor_suggestion 卡接线 review-proposal 正本（#356）
- `__tests__/` — auditor-agent/execution/reports/rules/supplementary/track-trends/zero-execution/auto-apply-audit/review-adapter

### 核心导出

- `index.ts` — 模块公共出口 barrel：`auditorService`、`getAuditorReviewAdapter`
- `auditor-rules`（#523 起 OKR 低达成建 okr_proposal 单收口 WorkUnitService.create——原 commitSnapshot 直写不发 eventBus 事件，对唤醒体系隐形）
- `auditor-execution`（低风险自动应用/确认卡片经 review-proposal 正本发卡/Resolution/Triage 升级；#439 起铃铛通知 link 带消息粒度——发卡后按 proposalId 反查卡消息拼 `?highlight=<mid>`，link 构造唯一出口 `buildAuditorNotificationLink`，反查不到降级频道粒度不阻断；#591 起低风险自动应用逐建议落 auto_apply 决策埋点——audit-logs 轨，一次运行共享 runId=requestId，依据=risk+detail 摘要，失败 status=failure 不阻断后续建议）
- `review-adapter`（#356：kind=auditor，onApprove 建未指派 task 工单；审批走通用端点 /review-proposals/auditor/:id/*；`findAuditorCardMessageId` = 按提案 id 反查卡消息唯一出口，onApprove 原卡链接与 #439 通知 link 共用）

### 依赖关系

- 上游：`modules/knowledge`（knowledgeService/resolutionService/evalCaseGenerator）、`modules/skills`（skillStore）、`modules/workunit`、`modules/review-proposal`（正本发卡）、`modules/audit-logs`（recordAgentDecision）、`core/store`、`utils/`（studio-events/message-meta/errors）；动态 import `modules/triage`（升级）、`modules/channels`、`modules/pmo`（压环）
- 下游：`bootstrap/services.ts`、`bootstrap/lifecycle.ts`、`modules/audit-logs`（proposal-source 动态 import 注册 review adapter）

### 注意事项

- **周期循环 scan-sharing（候选 3，2026-09-08）**：auditor generateSuggestions 的 4 周事件窗口每轮一次读、多消费方共享（原 skill 循环内 N+1 全窗口扫描）
- **Resolution 写入值域（M1，2026-09-21）**：auditor-execution `autoCreateResolutions` 的 `createResolution` 调用，layer 一律写 harness StorageLayer 合法值 `'project'`，原 L3/L4 分层值挪进 tags 保信息（值域正本与理由见 knowledge/CONTEXT.md 同名条目）
- **param_tuning 审计建议只指真生效旋钮（#593）**：auditor-rules 检测规则 3 的文案引用 `task.timeoutMs`/`silenceWarnMs`/`silenceKillMs`（runner-lightweight spawn 选项，配置入口 = agent-loop 侧常量）；`ExecutorConfig.sessionTimeoutMinutes`/`taskTimeoutMinutes` 两个只写不读字段已随 #589 删除、禁入面向人文案，`__tests__/auditor-rules.test.ts` 有白名单断言防同类回归
- **Auditor 零执行早退**：24h 零执行不 push 不记录不升级
