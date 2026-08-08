// Knowledge search analysis (preserved from original) —— 从 agent-loop.ts 原样抽出，行为不变。
import { parseStreamEvents, extractToolCalls } from '@dommaker/studio-shared';

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
}

/**
 * Analyze agent log for knowledge search behavior.
 * Pure function — takes log content string, no file I/O.
 */
export function analyzeKnowledgeSearch(logContent: string): KnowledgeSearchAnalysis {
  const events = parseStreamEvents(logContent);
  const toolCalls = extractToolCalls(events);

  const searchCalls: Array<{ tool: string; detail?: string }> = [];
  for (const call of toolCalls) {
    const detail = getKnowledgeSearchDetail(call.name, call.input);
    if (detail !== null) {
      searchCalls.push({ tool: call.name, detail });
    }
  }

  return { searched: searchCalls.length > 0, searchCalls };
}

function getKnowledgeSearchDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;

  if (toolName === 'Read') {
    const fp = inp.file_path;
    if (typeof fp === 'string' && fp.includes('.studio/knowledge')) return fp;
  }
  if (toolName === 'Bash') {
    const cmd = inp.command;
    if (typeof cmd === 'string' && cmd.includes('.studio/knowledge')) return cmd;
  }
  if (toolName === 'Glob') {
    const pattern = inp.pattern;
    if (typeof pattern === 'string' && pattern.includes('.studio/knowledge')) return pattern;
  }

  return null;
}

/**
 * Extract knowledge entry IDs from search analysis results.
 * Parses file paths from Read/Bash tool call details.
 */
export function extractKnowledgeEntryIds(analysis: KnowledgeSearchAnalysis): string[] {
  const ids: string[] = [];
  for (const call of analysis.searchCalls) {
    if (!call.detail) continue;
    const match = call.detail.match(/\.studio\/knowledge\/([^/\s]+(?:\/[^/\s]+)?\.md)/);
    if (match) {
      const filePart = match[1];
      if (filePart === '_index.md' || filePart.endsWith('/_index.md')) continue;
      ids.push(filePart.replace(/\.md$/, ''));
    }
  }
  return Array.from(new Set(ids));
}
