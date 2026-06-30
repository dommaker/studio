/**
 * Agent Event Listener - Facade
 *
 * @deprecated Pipeline（Goal 系统）已废弃，由 Agent Network 替代。Phase 4 将删除整个 goals/ 目录。
 *
 * P11-05: Split into sub-modules:
 *   event-handler.ts — core event handling logic
 *   knowledge-promoter.ts — knowledge promotion logic
 *
 * Re-exports for zero breaking changes.
 */
export { AgentEventListener, agentEventListener } from './event-handler.js';
