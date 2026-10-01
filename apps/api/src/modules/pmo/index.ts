/**
 * pmo 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { AnalysisHandoff } from './analysis-handoff.js';
export { matchWuToLeg } from './evidence-summary.js';
export { MAP_OPENING_FOG_MAX, parseMapOpening } from './map-opening.js';
export { applyPlanDirection, PlanDirectionError, validateDirectionPick } from './plan-direction.js';
export { applyPlanRuling, PlanRulingError, validateRulingItems } from './plan-ruling.js';
export { projectService, resolveDeliveries, resolveDeliveryPolicy } from './project.service.js';
export type { DeliveryPolicy, ProjectData } from './project.service.js';
export { parseSpecTasks, serializeSpecTasks, SPEC_TASKS_MAX } from './spec-materialization.js';
export type { SpecTaskSpec } from './spec-materialization.js';
