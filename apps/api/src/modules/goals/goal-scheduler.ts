/**
 * Goal Scheduler - Facade
 *
 * 轮询 executing 状态的 Goal，调度可执行的 step。
 *
 * P11-01: Split into sub-modules:
 *   scheduler-queue.ts — 路由分类、资源管理、队列管理
 *   scheduler-dispatch.ts — dispatch 执行、prompt 构建、结果处理
 *   scheduler-integration.ts — GoalScheduler 类的生命周期和调度循环
 */

export { GoalScheduler, goalScheduler } from './scheduler-integration.js';

// Re-export types and standalone functions for zero breaking changes
export type { ClassificationRecord, TierRoutingConfig } from './scheduler-queue.js';
export {
  DEFAULT_TIER_ROUTING,
  getAvailableSlots,
  detectConflicts,
  classifyTaskComplexity,
  inferTaskCategory,
  getHistoricalBestTier,
  persistRoutingStats,
  restoreRoutingStats,
  maybeExploreDowngrade,
  analyzeRoutingFeedback,
  getDispatchStrategy,
  updateDispatchOutcome,
  parseAgentTokenUsage,
} from './scheduler-queue.js';

export type { DispatchContext } from './scheduler-dispatch.js';
export { dispatchStep } from './scheduler-dispatch.js';
export {
  buildSubAgentPrompt,
  buildLegacyPrompt,
  buildIntegrationPrompt,
  getSiblingContext,
  getCompanyKnowledge,
  getProjectRepoPath,
  findTaskBranch,
  runIntegrationInCode,
} from './scheduler-prompt.js';
