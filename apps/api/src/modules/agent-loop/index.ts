/**
 * agent-loop 模块公共出口（P2-d 刀5：自 modules/agents/loop 提升）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 提升时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { agentLoopRegistry } from './agent-loop-registry.js';
export { getDailyTokenUsage, resolveDailyTokenBudget, tokenBudgetGuardEnabled } from './daily-token-budget.js';
export { reconcileDispatchBreaks } from './dispatch-reconciliation.js';
export { EXECUTION_STREAM_SSE_TYPE } from './execution-step-events.js';
export { getReviewDispatcher } from './review-dispatcher.js';
export { CODE_WORKTREE_TYPES, resolveVerifyCommands, runWuVerification } from './wu-verification.js';
