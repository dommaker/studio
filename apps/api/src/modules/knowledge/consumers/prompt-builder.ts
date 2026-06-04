/**
 * Unified knowledge injection entry point.
 * Phase 2: uses UnifiedQuery for rules/context (full injection) + signal (index injection).
 */
import { UnifiedQuery } from '../engine/unified-query.js';
import { knowledgeBus } from '../knowledge-bus.service.js';

interface BuildOptions {
  /** 'compact' = rules + context (default), 'full' = all knowledge types */
  mode?: 'compact' | 'full';
}

// Singleton — lazy init
let _uq: UnifiedQuery | null = null;
function getUnifiedQuery(): UnifiedQuery {
  if (!_uq) _uq = new UnifiedQuery();
  return _uq;
}

/**
 * Strip markdown formatting for prompt injection safety.
 */
function stripFormat(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')    // headings
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/`([^`]+)`/g, '$1')    // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^>\s+/gm, '')         // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '- ') // list markers (normalize)
    .trim();
}

/**
 * Build knowledge context for an agent's prompt.
 * - rule: full content injection (constraints must be followed)
 * - context: full content injection (preferences/environment)
 * - signal: index injection (informational, agent searches on demand)
 * - reference: not injected, hint only
 */
export async function buildKnowledgeContext(
  agentType: string,
  options?: BuildOptions,
): Promise<string> {
  const uq = getUnifiedQuery();
  const sections: string[] = [];

  // 1. rule — full content injection (constraints must be followed)
  const rules = await uq.queryEntries({ consumptionModes: ['rule'], agentType });
  if (rules.length) {
    const lines = rules.map(r => `- ${stripFormat(r.content)}`);
    sections.push(`## 系统约束\n${lines.join('\n')}`);
  }

  // 2. context — full content injection (preferences + environment)
  const context = await uq.queryEntries({ consumptionModes: ['context'] });
  if (context.length) {
    const lines = context.map(c => `- ${stripFormat(c.content)}`);
    sections.push(`## 上下文\n${lines.join('\n')}`);
  }

  // 3. signal — index injection (informational)
  const signals = uq.getIndexes({ consumptionModes: ['signal'], limit: 5 });
  if (signals.length) {
    const lines = signals.map(s => `- [${s.id}] ${s.summary}`);
    sections.push(`## 近期信号\n${lines.join('\n')}`);
  }

  // 4. reference — hint only
  const refCount = await uq.count({ consumptionModes: ['reference'] });
  if (refCount > 0) {
    sections.push(`[知识库: ${refCount} 条参考，遇到问题时用 search()]`);
  }

  // 5. knowledge index summary (legacy compatibility — formatIndexSummary)
  const index = knowledgeBus.formatIndexSummary();
  if (index) {
    sections.push(index);
  }

  return sections.join('\n\n');
}
