/**
 * Knowledge Keeper 查询 — 搜索公司 Wiki 知识库
 *
 * 供 Analyst/Executor/Reviewer 在启动时查询历史经验。
 * 使用简单文本匹配 + INDEX 遍历（后续可升级为语义搜索）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BASE_DIR = path.join(os.homedir(), 'knowledge-base', 'companies');

export interface QueryResult {
  pagePath: string;        // relative path, e.g. "projects/PMO-2026-001.md"
  title: string;
  relevance: number;       // 0-1, higher = more relevant
  snippet: string;         // first 300 chars
}

/**
 * 查询公司知识库
 * @param companyId 公司 ID
 * @param query 搜索关键词（空格分隔）
 * @param maxResults 最大返回数
 */
export function queryCompanyKnowledge(
  companyId: string,
  query: string,
  maxResults = 5,
): QueryResult[] {
  const root = path.join(BASE_DIR, companyId, 'wiki');
  if (!fs.existsSync(root)) return [];

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  const results: QueryResult[] = [];

  // 递归遍历 wiki 目录
  function walk(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = rel + entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath + '/');
      } else if (entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : entry.name.replace('.md', '');

        // 简单相关性评分：关键词命中次数 / 关键词总数
        const lowerContent = content.toLowerCase();
        let hitCount = 0;
        for (const kw of keywords) {
          if (lowerContent.includes(kw)) hitCount++;
        }
        const relevance = keywords.length > 0 ? hitCount / keywords.length : 0;

        if (relevance > 0) {
          // 提取摘要（跳过 frontmatter）
          let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          body = body.replace(/^#\s+.+\n/, '').trim();
          const snippet = body.slice(0, 300).replace(/\n/g, ' ');

          results.push({
            pagePath: relPath,
            title,
            relevance,
            snippet,
          });
        }
      }
    }
  }

  walk(root, '');

  // 按相关性降序排序
  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, maxResults);
}

/**
 * 查询技能（专门搜索 skills/ 目录）
 */
export function queryCompanySkills(
  companyId: string,
  taskDescription: string,
  maxResults = 3,
): QueryResult[] {
  const results = queryCompanyKnowledge(companyId, taskDescription, 20);
  return results
    .filter(r => r.pagePath.startsWith('skills/'))
    .slice(0, maxResults);
}

/**
 * 查询坑位（专门搜索 pitfalls/ 目录）
 */
export function queryCompanyPitfalls(
  companyId: string,
  taskDescription: string,
  maxResults = 3,
): QueryResult[] {
  const results = queryCompanyKnowledge(companyId, taskDescription, 20);
  return results
    .filter(r => r.pagePath.startsWith('pitfalls/'))
    .slice(0, maxResults);
}

/**
 * 格式化查询结果为 prompt 注入文本
 */
export function formatQueryResults(results: QueryResult[]): string {
  if (results.length === 0) return '';
  return [
    '## 公司知识库参考',
    '以下是你公司积累的相关经验和模式：',
    '',
    ...results.map((r, i) => `${i + 1}. **${r.title}** (${r.pagePath}, 相关性: ${(r.relevance * 100).toFixed(0)}%)\n   ${r.snippet}`),
  ].join('\n');
}
