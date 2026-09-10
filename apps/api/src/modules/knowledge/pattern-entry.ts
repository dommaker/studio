/**
 * pattern-entry — 交互模式（type='pattern'）条目的查询与正文解析统一口径
 *
 * 根因（2026-09-10 生产 /api/v1/knowledge/search 500）：tag 'pattern' 是自由命名
 * 空间，guideline 条目（session-summary 等）也合法携带，且正文是 markdown 而非
 * JSON。消费方（search.routes / pattern-miner）拿裸 tag 当类型判别、再裸
 * JSON.parse 正文，遇到 markdown 条目即 SyntaxError 打垮整个读路径。
 * 结构化字段 type='pattern' 才是唯一可靠判别（生产方 upsertPattern 写入）；
 * 即便 type 收敛后，正文 JSON 仍只是约定（条目可被手工编辑/外部写入），解析
 * 失败一律视为数据损坏跳过，不得抛异常打垮调用方。
 */

import type { KnowledgeEntry, KnowledgeStore, KnowledgeSubsystem, QueryFilter } from '@dommaker/harness';

/**
 * 交互模式条目的查询口径：types:['pattern'] 为判别字段；extraTags 原样透传
 * （调用方原来的 tags 数组去掉冗余的 'pattern' —— type 已等价表达）。
 * cast 说明：'pattern' 是运行时已存在的 off-schema type（upsertPattern 以 as any
 * 写入，生产 index.json 均为 type:'pattern'），harness KnowledgeSubsystem 词表
 * 未收录；词表扩展属 harness 包发布范畴，不在本修复范围。
 */
export function listInteractionPatterns(store: KnowledgeStore, extraTags?: string[]): KnowledgeEntry[] {
  const filter: QueryFilter = { types: ['pattern' as KnowledgeSubsystem] };
  if (extraTags && extraTags.length > 0) filter.tags = extraTags;
  return store.list(filter);
}

/**
 * 安全解析模式条目正文：合法 JSON object → 解析结果；空正文 → {}（兼容既有
 * `content || '{}'` 口径）；非 JSON / 非 object → null（调用方必须跳过该条目，
 * 见文件头根因注释）。
 */
export function parsePatternContent(content: string | undefined | null): Record<string, any> | null {
  if (!content) return {};
  try {
    const d: unknown = JSON.parse(content);
    return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, any>) : null;
  } catch {
    return null;
  }
}
