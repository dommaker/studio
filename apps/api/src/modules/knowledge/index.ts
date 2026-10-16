/**
 * knowledge 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { envSnapper } from './producers/env-snapper.js';
export { evalCaseGenerator } from './producers/eval-case-generator.js';
export { startEvolutionScheduler, stopEvolutionScheduler } from './scheduling/evolution-scheduler.js';
export { checkDocumentFreshness } from './knowledge-design-doc.js';
export { knowledgeService } from './knowledge-service.js';
export type { AuditReport, FlywheelMetrics } from './knowledge-service.js';
export { scheduleVectorDbSync, sharedLifecycle, sharedStore, UNIFIED_KNOWLEDGE_DIR, verifyConsumptionChain } from './knowledge-singletons.js';
export { knowledgeSync } from './scheduling/knowledge-sync.service.js';
export { preferenceObserver } from './producers/preference-observer.js';
export { resolutionService } from './resolution.service.js';
export { getKnowledgeReviewAdapter } from './review-adapter.js';
export { ruleScanner } from './producers/rule-scanner.js';
