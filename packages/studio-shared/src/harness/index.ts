/**
 * Harness 集成层 — studio 侧自有模块（#150 A5 删薄后）
 *
 * 纯透传 @dommaker/harness 的 wrapper 层已退役：消费方直接 import
 * @dommaker/harness（getAllConstraints / getConstraint / checkConstraint /
 * checkConstraints 等），本文件只保留 studio 侧自有的编排/适配模块。
 * （InputGuardrail / OutputGuardrail / Sandbox 已随 harness 1.2.0 ADR-0003 删除。）
 */

// Prompt injection — 约束前置声明路由层（role→trigger；渲染走 harness renderConstraintsByTrigger）
export { formatConstraintsForPrompt } from './prompt-injection';
export type { AgentRole, FormatConstraintsOptions } from './prompt-injection';

// Session metrics (observability)
export { parseSessionMetrics } from './session-metrics';
export type { SessionMetrics } from './session-metrics';

// Per-provider usage 提取（#134：opencode/codex 分流，kimi 无出口 → null）
export { extractProviderUsage } from './provider-usage';
export type { ProviderUsage } from './provider-usage';

// Harness 运行时 & Hooks（Phase 2: 迁移到新 hooks 管线）
export { bootstrapHarness, getHarness, getPipeline, isHarnessInitialized } from './runtime/bootstrap';
export type { HarnessBootstrap } from '@dommaker/harness';
export * from './hooks/index';
// Wiki 服务已移除 (B11-002): KnowledgeKeeper/wiki-service/knowledge-query
// 知识系统统一使用 harness KnowledgeStore + KnowledgeBus
