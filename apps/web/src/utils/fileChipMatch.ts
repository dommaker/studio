// #285（决策 #249 §5）：agent 消息 inline-code（反引号）路径 token ↔ 文件词表匹配纪律。
// 词表来源降级判定：票体要求「WU 产出/修改文件集优先」，但服务端没有 per-WU 产出/修改文件集的
// 查询面（tool:call 事件在 jsonl，无 per-WU API），按决策降级用候选集词表（#281 file-vocabulary），
// 守同一匹配纪律：全词表（所有仓合并）恰好唯一命中才染 chip，多条命中（含 basename 不唯一）不渲染。
import type { ChannelFileVocabulary, FileRef } from '../api/channel';

export interface ContentSegment {
  type: 'text' | 'code';
  text: string;
}

/** 把正文按 `...` inline-code 切分成 text/code 段；不成对的反引号保持原文 text */
export function splitInlineCode(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const re = /`([^`]*)`/g;
  let last = 0;
  for (const m of content.matchAll(re)) {
    if (m.index > last) segments.push({ type: 'text', text: content.slice(last, m.index) });
    segments.push({ type: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: 'text', text: content.slice(last) });
  return segments;
}

/**
 * token（trim 后）满足 path === token 或 path 以 '/' + token 结尾（路径边界后缀）即候选；
 * 全词表恰好命中唯一一条才返回 FileRef，否则 null。空 token / 含换行跳过。
 */
export function matchFileRefToken(token: string, vocabulary: ChannelFileVocabulary): FileRef | null {
  const t = token.trim();
  if (!t || t.includes('\n') || t.includes('\r')) return null;
  let hit: FileRef | null = null;
  for (const { repo, files } of vocabulary.repos) {
    for (const path of files) {
      if (path === t || path.endsWith('/' + t)) {
        if (hit) return null; // 第二条命中 → 歧义，不染 chip
        hit = { repo, path };
      }
    }
  }
  return hit;
}

/** chip tooltip / 剪贴板用的绝对路径（repo 尾斜杠归一，防双斜杠） */
export function fileRefFullPath(ref: FileRef): string {
  return `${ref.repo.replace(/\/+$/, '')}/${ref.path.replace(/^\/+/, '')}`;
}
