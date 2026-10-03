/**
 * workunit 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { buildAssigneeProfileResolver } from './assignee-resolver.js';
export type { AssigneeProfileResolver } from './assignee-resolver.js';
export { buildDeadLetterNotice, summarizeBlockReason, withBlockedCta } from './blocked-cta.js';
export { claimWorkUnitAndAnnounce } from './claim-announce.js';
export { checkDelegation, effectiveParentCollab, MAX_DELEGATIONS_PER_PARENT, readCollab, resolveMaxDepth, TREE_TOKEN_BUDGET } from './delegation-gate.js';
export type { CollabMeta } from './delegation-gate.js';
export { scanGateEscalationReminders } from './gate-escalation.js';
export { initInReviewInbox } from './in-review-inbox.js';
export { MAX_TIMEOUT_RELEASES, pidStartMatchesInstance, scanTimedOutWorkUnits } from './timeout-release.js';
export { resumeWaitingWorkUnit, scanWaitingForInputReminders } from './waiting-input.js';
export { snapshotToData } from './workunit-crud.js';
export { ANALYSIS_TASKS_MAX, INSPECTION_OPPORTUNITIES_MAX, WorkUnitService } from './workunit.service.js';
export type { WorkUnitData } from './workunit.service.js';
export { DECISION_SPEC_TYPES, MANUAL_GATE_TYPES, PLAN_STEP_LIMIT, WU_LEASE_TTL_MS } from './workunit.types.js';
export type { UnfitRoleEntry, WorkUnitMetadata } from './workunit.types.js';
export { buildStatusById, hasUnfinishedDeps } from './wu-dependencies.js';
export { postWuSystemMessage } from './wu-messenger.js';
export { clearSessionBookkeeping, mergedWuView, parseWuMetadata, parseWuTitle } from './wu-metadata.js';
