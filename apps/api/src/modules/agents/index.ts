/**
 * agents 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { summarizeRoleStates } from './agent-instance.service.js';
export { ensureStudioProfile } from './agent-profile.service.js';
export { backfillProfileProviders } from './default-provider.js';
export { registerDefaultTriggers } from './default-triggers.js';
export { reconcileDispatchBreaks } from './dispatch-reconciliation.js';
export { scanStaleAgentInstances } from './instance-timeout-scan.js';
export { getExtractFromTextSystemPrompt, knowledgeCurator } from './knowledge/knowledge-curator.service.js';
export { agentLoopRegistry } from './loop/agent-loop-registry.js';
export { getDailyTokenUsage, resolveDailyTokenBudget, tokenBudgetGuardEnabled } from './loop/daily-token-budget.js';
export { EXECUTION_STREAM_SSE_TYPE } from './loop/execution-step-events.js';
export { getReviewDispatcher } from './loop/review-dispatcher.js';
export { CODE_WORKTREE_TYPES, resolveVerifyCommands, runWuVerification } from './loop/wu-verification.js';
export { dispatchMonitorAlerts, emitMonitorEvent } from './monitor/monitor-alerts.js';
export { monitorService } from './monitor/monitor.service.js';
export { sessionSummaryService } from './session-summary.service.js';
export { getSystemExecutor, StudioRoleNotConfiguredError } from './system-executor.js';
export { isSystemRole, STUDIO_ROLE_NAME } from './system-role.js';
export { aggregateTreeTokens, sumTokensForWorkUnits } from './token-usage.service.js';
