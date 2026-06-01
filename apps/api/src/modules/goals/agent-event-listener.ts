/**
 * Agent Event Listener - Facade
 *
 * P11-05: Split into sub-modules:
 *   event-handler.ts — core event handling logic
 *   review-orchestrator.ts — review process orchestration
 *   knowledge-promoter.ts — knowledge promotion logic
 *
 * Re-exports for zero breaking changes.
 */
export { AgentEventListener, agentEventListener } from './event-handler.js';
export { MAX_REVIEW_CYCLES } from './review-orchestrator.js';
