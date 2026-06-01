/**
 * Analyst Knowledge — 知识加载、保存、段落筛选
 *
 * 从 analyst-trigger.service.ts 提取的纯函数。
 */
import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';

export const ANALYST_DIR = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || process.cwd(), '.analyst');
export const KNOWLEDGE_FILE = path.join(ANALYST_DIR, 'knowledge.md');

export function perInvocationOutputFile(): string {
  return path.join(ANALYST_DIR, `output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
}

export function ensureWorktree(): void {
  if (!fs.existsSync(ANALYST_DIR)) {
    fs.mkdirSync(ANALYST_DIR, { recursive: true });
  }
}

export function loadKnowledge(): string {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      const content = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
      // Only include if fresh (< 24h)
      const stat = fs.statSync(KNOWLEDGE_FILE);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        return content;
      }
    }
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to load knowledge', { error: String(e) });
  }
  return '';
}

export function saveKnowledge(analysisTitle: string, findings: string): void {
  ensureWorktree();
  const entry = `\n## ${new Date().toISOString().slice(0, 10)} — ${analysisTitle}\n${findings}\n`;
  try {
    const existing = fs.existsSync(KNOWLEDGE_FILE)
      ? fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
      : '# Analyst 知识积累\n\n代码库探索记录，跨分析会话复用。\n';
    fs.writeFileSync(KNOWLEDGE_FILE, existing + entry, 'utf-8');
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to save knowledge', { error: String(e) });
  }
}

/**
 * Q7: 按 `## ` 标题分割知识文档，选取与需求关键词匹配的段落
 * 避免无关历史分析污染 Analyst 上下文。无匹配时回退到末尾段落。
 */
export function selectRelevantSections(knowledge: string, requirement: string, maxChars: number): string {
  if (!knowledge || knowledge.length <= maxChars) return knowledge;

  const sections = knowledge.split(/(?=^## )/m).filter(s => s.trim());
  if (sections.length <= 1) return knowledge.slice(-maxChars);

  // 从需求提取关键词
  const reqWords = new Set(
    requirement.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );

  // 按匹配关键词数降序排列段落
  const scored = sections.map(s => {
    const lower = s.toLowerCase();
    const hits = [...reqWords].filter(w => lower.includes(w)).length;
    return { section: s, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);

  // 取 Top-N 段落（不超过 maxChars）
  let result = '';
  for (const { section } of scored) {
    if (result.length + section.length > maxChars) break;
    result += section + '\n';
  }

  // 回退：无匹配时取最末尾的段落（最新知识）
  if (!result.trim()) {
    result = sections.slice(-2).join('\n').slice(-maxChars);
  }

  return result;
}
