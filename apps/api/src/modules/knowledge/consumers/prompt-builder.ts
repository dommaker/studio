/**
 * Unified knowledge injection entry point.
 * Single entry for all agent knowledge injection.
 * - rule: full content injection (constraints must be followed)
 * - context: full content injection (preferences/environment)
 * - signal: index injection (informational, agent searches on demand)
 * - reference: not injected, hint only
 * - skill: evolved Skill prompts (AC-8d)
 *
 * Also handles:
 * - Knowledge stats summary (how many entries available)
 * - recordReference calls (closes maturity loop)
 */
import { UnifiedQuery, type IndexEntry } from '../engine/unified-query.js';
import { sharedStore, sharedLifecycle } from '../knowledge-bus.service.js';
import { skillLoader } from '@dommaker/studio-skill';

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
 * Record references for injected entries (closes maturity loop).
 * Best-effort: failures don't block injection.
 */
function recordReferences(entryIds: string[]): void {
  for (const id of entryIds) {
    try { sharedLifecycle.recordReference(id, 'prompt-inject'); } catch { /* non-blocking */ }
  }
}

/**
 * Build knowledge stats summary line.
 */
function buildStatsSummary(): string {
  try {
    const entries = sharedStore.list({});
    const total = entries.length;
    if (total === 0) return '';

    const typeLabels: Record<string, string> = {
      pattern: '代码模式',
      pitfall: '坑点',
      guideline: '规范',
      fix: '修复方案',
      trend: '趋势',
    };

    const byType: Record<string, number> = {};
    for (const e of entries) {
      const cat = e.tags?.[0] || 'other';
      byType[cat] = (byType[cat] || 0) + 1;
    }

    const parts = [`知识库: ${total} 条`];
    for (const [type, label] of Object.entries(typeLabels)) {
      const count = byType[type] || 0;
      if (count > 0) parts.push(`${label} ${count}`);
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}

/**
 * AC-8d: Build Skill index for injection.
 * AS-021: 只注入元数据（name + description），Agent 按需通过 loadSkill MCP tool 加载完整内容。
 */
function buildSkillPrompts(agentType: string): string {
  const skills = skillLoader.load({ trigger: 'always', agentType });
  if (!skills.length) return '';

  const skillIndex = skillLoader.formatForPrompt(skills);
  if (!skillIndex) return '';

  return [
    '## 已激活 Skills',
    '以下 skill 可用。需要时使用 `loadSkill` MCP tool 加载完整内容。',
    '',
    skillIndex,
  ].join('\n');
}

/**
 * Build knowledge context for an agent's prompt.
 */
export async function buildKnowledgeContext(
  agentType: string,
  options?: BuildOptions,
): Promise<string> {
  const uq = getUnifiedQuery();
  const sections: string[] = [];
  const injectedIds: string[] = [];

  // 1. rule — full content injection (constraints must be followed)
  const rules = await uq.queryEntries({ consumptionModes: ['rule'], agentType });
  if (rules.length) {
    const lines = rules.map(r => `- ${stripFormat(r.content)}`);
    sections.push(`## 系统约束\n${lines.join('\n')}`);
    injectedIds.push(...rules.map(r => r.id));
  }

  // 2. context — full content injection (preferences + environment)
  const context = await uq.queryEntries({ consumptionModes: ['context'], agentType });
  if (context.length) {
    const lines = context.map(c => `- ${stripFormat(c.content)}`);
    sections.push(`## 上下文\n${lines.join('\n')}`);
    injectedIds.push(...context.map(c => c.id));
  }

  // 3. signal — index injection (informational)
  // 优先注入聚合趋势摘要，无趋势时回退原始信号
  const TREND_TAG = 'trend-aggregated';
  let signals = uq.getIndexes({ consumptionModes: ['signal'], tags: [TREND_TAG], agentType, limit: 5 });
  if (signals.length === 0) {
    signals = uq.getIndexes({ consumptionModes: ['signal'], agentType, limit: 5 });
  }
  if (signals.length) {
    const lines = signals.map(s => `- [${s.id}] ${s.summary}`);
    sections.push(`## 近期信号\n${lines.join('\n')}`);
    injectedIds.push(...signals.map(s => s.id));
  }

  // 4. reference — hint only
  const refCount = await uq.count({ consumptionModes: ['reference'] });
  if (refCount > 0) {
    sections.push(`[知识库: ${refCount} 条参考，遇到问题时用 search()]`);
  }

  // 5. AC-8d: Skill prompts — evolved skills from knowledge pipeline
  try {
    const skillSection = buildSkillPrompts(agentType);
    if (skillSection) sections.push(skillSection);
  } catch { /* non-blocking */ }

  // 6. knowledge stats summary
  const stats = buildStatsSummary();
  if (stats) {
    sections.push(stats);
  }

  // 7. recordReference — close maturity loop
  if (injectedIds.length > 0) {
    recordReferences(injectedIds);
  }

  // 缓存本次注入的 ID，供调用方通过 getLastInjectedIds() 获取
  _lastInjectedIds = injectedIds;

  return sections.join('\n\n');
}

/** 获取最近一次 buildKnowledgeContext 注入的条目 ID */
let _lastInjectedIds: string[] = [];
export function getLastInjectedIds(): string[] {
  return _lastInjectedIds;
}
