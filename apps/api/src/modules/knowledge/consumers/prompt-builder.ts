/**
 * Unified knowledge injection entry point.
 * Phase 1: wraps existing functions (formatCompactForPrompt + formatIndexSummary).
 * Phase 2: will switch to UnifiedQuery.
 */
import { knowledgeQuery } from '../knowledge-query.service.js';
import { knowledgeBus } from '../knowledge-bus.service.js';

interface BuildOptions {
  /** 'compact' = top rules + context (default), 'full' = all knowledge types */
  mode?: 'compact' | 'full';
}

/**
 * Build knowledge context for an agent's prompt.
 * Combines rules + context with knowledge index summary.
 *
 * @param agentType - Agent identifier (e.g. 'executor', 'analyst', 'reviewer')
 * @param options - { mode: 'compact' | 'full' }
 * @returns Combined knowledge context string for prompt injection
 */
export async function buildKnowledgeContext(
  agentType: string,
  options?: BuildOptions,
): Promise<string> {
  const mode = options?.mode ?? 'compact';
  const sections: string[] = [];

  // Rules + context
  if (mode === 'full') {
    const all = await knowledgeQuery.formatAllForPrompt(agentType);
    if (all) sections.push(all);
  } else {
    const compact = await knowledgeQuery.formatCompactForPrompt(agentType);
    if (compact) sections.push(compact);
  }

  // Knowledge index summary
  const index = knowledgeBus.formatIndexSummary();
  if (index) {
    sections.push(index);
  }

  return sections.join('\n\n');
}
