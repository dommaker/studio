/**
 * requirements 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { deriveChannelReqPmo, listChannelReqPmoProjects } from './channel-req-pmo.js';
export type { ChannelReqPmoLink, ProjectLike } from './channel-req-pmo.js';
export { OWNERSHIP_WAITING_QUESTION, resolveWorkspaceForWU } from './ownership-resolver.js';
export { resolvePmoBranchForWU, resolvePmoProjectIdForWU } from './pmo-branch-resolver.js';
export { resolveReqIdForDispatch } from './req-binding.js';
export { RequirementService, TERMINAL_WORKUNIT_STATUSES } from './requirement.service.js';
export type { RequirementWithProject } from './requirement.service.js';
export { parseWuPmoId } from './wu-pmo-attribution.js';
