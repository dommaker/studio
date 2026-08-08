/**
 * knowledge-semantic-search — mcp-local-rag 语义检索支撑。
 *
 * 从 knowledge-service.ts 抽出（工单 29，纯搬运不改逻辑）：
 * - probeMcpLocalRag：RAG CLI 可用性探测
 * - execMcpLocalRagQuery：执行 `mcp-local-rag query` CLI 并返回 stdout JSON
 * - resolveKnowledgeEntryId：filePath → 知识条目 ID（YAML frontmatter / 文件名解析）
 * - keywordHitsToSemantic：RAG 不可用时 searchKeyword 结果 → SemanticSearchResult 降级映射
 *
 * 模块级函数不占 prototype 方法数（knowledge-service.test.ts 锁定 33）；
 * KnowledgeService.semanticSearch/execMcpQuery/resolveEntryId 为薄封装。
 */

import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join, basename } from 'path';
import type { SearchResult, SemanticSearchResult } from './knowledge-service.js';

/** mcp-local-rag 可用性探测缓存 TTL（5 分钟） */
export const RAG_PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * 探测 mcp-local-rag CLI 是否可用。
 * 用 `--help` 做最轻量存活检查（该 CLI 不支持 --version；status 需加载向量库，太重）。
 */
export function probeMcpLocalRag(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile('mcp-local-rag', ['--help'], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

/**
 * Execute mcp-local-rag query CLI and return stdout JSON.
 */
export function execMcpLocalRagQuery(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--db-path', join(process.env.HOME || '/root', '.cache', 'mcp-local-rag', 'lancedb'),
      '--cache-dir', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub'),
      '--model-name', join(process.env.HOME || '/root', '.cache', 'huggingface', 'hub', 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main'),
      'query', query,
    ];
    execFile('mcp-local-rag', args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        // mcp-local-rag logs to stderr, stdout has JSON result even on partial error
        if (stdout && stdout.trim().startsWith('[')) {
          resolve(stdout);
        } else {
          reject(err);
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Resolve knowledge entry ID from a filePath.
 * Reads YAML frontmatter `id:` field; falls back to filename parsing.
 */
export async function resolveKnowledgeEntryId(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const match = content.match(/^---[\s\S]*?^id:\s*(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* file not readable */ }

  // Fallback: parse filename pattern "{type}-{id}.md"
  const name = basename(filePath, '.md');
  const dashIdx = name.indexOf('-');
  return dashIdx > 0 ? name.slice(dashIdx + 1) : name;
}

/**
 * RAG 不可用时的降级检索结果映射：searchKeyword 的 SearchResult → SemanticSearchResult。
 * 知识库确实无相关条目时 searchKeyword 返回 []，此处如实映射为空（不编造）。
 */
export function keywordHitsToSemantic(hits: SearchResult[]): SemanticSearchResult[] {
  return hits.map(h => ({
    entryId: h.entry.id,
    filePath: (h.entry as any).sourceReference || '',
    chunkIndex: 0,
    text: h.highlights[0] || (h.entry.content || '').slice(0, 200),
    score: h.score,
    fileTitle: h.entry.title || '',
  }));
}
