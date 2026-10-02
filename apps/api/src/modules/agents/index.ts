/**
 * agents 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { AgentInstanceService, INSTANCE_ALIVE_TIMEOUT_MS, summarizeRoleStates } from './agent-instance.service.js';
export { ensureStudioProfile } from './agent-profile.service.js';
export { backfillProfileProviders } from './default-provider.js';
export { registerDefaultTriggers } from './default-triggers.js';
export { getExtractFromTextSystemPrompt, knowledgeCurator } from './knowledge/knowledge-curator.service.js';
export { sessionSummaryService } from './session-summary.service.js';
export { getSystemExecutor, StudioRoleNotConfiguredError } from './system-executor.js';
export { isSystemRole, STUDIO_ROLE_NAME } from './system-role.js';
export { aggregateTreeTokens, sumTokensForWorkUnits } from './token-usage.service.js';
