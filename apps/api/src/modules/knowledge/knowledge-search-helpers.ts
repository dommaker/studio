/**
 * knowledge-search-helpers — 关键词检索与 RAG 降级 helpers
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：关键词抽取（停用词过滤）、
 * 检索类型权重、mcp-local-rag 可用性探测与关键词降级映射。
 * 模块级函数（不占 KnowledgeService prototype 方法数），
 * 供 searchKeyword / semanticSearch 调用。
 */

import { execFile } from 'child_process';
import type { SearchResult, SemanticSearchResult } from './knowledge-types.js';

// ── Stop words for keyword extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'this', 'that', 'these', 'those', 'it', 'its',
  '需要', '实现', '增加', '修改', '支持', '添加', '使用', '一个',
]);

const TYPE_WEIGHT: Record<string, number> = {
  pitfall: 3, pattern: 2, guideline: 2, fix: 2,
  process: 1, analysis: 1, trend: 1,
};

function extractKeywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）\(\)\[\]{}<>\/\\|@#$%^&*+=~`!\-_]+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 8);
}

// ── E2（断点 G）：RAG 可用性探测 + 关键词降级（模块级，不占 prototype 方法数）──

/** mcp-local-rag 可用性探测缓存 TTL（5 分钟） */
const RAG_PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * 探测 mcp-local-rag CLI 是否可用。
 * 用 `--help` 做最轻量存活检查（该 CLI 不支持 --version；status 需加载向量库，太重）。
 */
function probeMcpLocalRag(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile('mcp-local-rag', ['--help'], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

/**
 * RAG 不可用时的降级检索结果映射：searchKeyword 的 SearchResult → SemanticSearchResult。
 * 知识库确实无相关条目时 searchKeyword 返回 []，此处如实映射为空（不编造）。
 */
function keywordHitsToSemantic(hits: SearchResult[]): SemanticSearchResult[] {
  return hits.map(h => ({
    entryId: h.entry.id,
    filePath: (h.entry as any).sourceReference || '',
    chunkIndex: 0,
    text: h.highlights[0] || (h.entry.content || '').slice(0, 200),
    score: h.score,
    fileTitle: h.entry.title || '',
  }));
}

export { TYPE_WEIGHT, extractKeywords, RAG_PROBE_TTL_MS, probeMcpLocalRag, keywordHitsToSemantic };
