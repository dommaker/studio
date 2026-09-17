/**
 * Harness 集成层 — studio 侧自有模块（#150 A5 删薄后）
 *
 * 纯透传 @dommaker/harness 的 wrapper 层已退役：消费方直接 import
 * @dommaker/harness（getAllConstraints / getConstraint / checkConstraint /
 * checkConstraints 等），本文件只保留 studio 侧自有的编排/适配模块。
 * （InputGuardrail / OutputGuardrail / Sandbox 已随 harness 1.2.0 ADR-0003 删除。）
 */

// Session metrics (observability)
export { parseSessionMetrics } from './session-metrics';
export type { SessionMetrics } from './session-metrics';

// Per-provider usage 提取（#134：opencode/codex 分流，kimi 无出口 → null）
export { extractProviderUsage } from './provider-usage';
export type { ProviderUsage } from './provider-usage';

// Harness 运行时（#562：hooks 管线层已收缩，只保留 bootstrap 初始化）
export { bootstrapHarness, getHarness, isHarnessInitialized } from './runtime/bootstrap';
export type { HarnessBootstrap } from '@dommaker/harness';

// 决策级审计事件发布（原 hooks/audit.ts，#562 随 hooks 层收缩上移一级）
export { recordDecision, recordDecisions } from './audit';
export type { AuditEvent } from './audit';
// Wiki 服务已移除 (B11-002): KnowledgeKeeper/wiki-service/knowledge-query
// 知识系统统一使用 harness KnowledgeStore + KnowledgeBus
