// #285（决策 #249 §5）：agent 消息 inline-code（反引号）路径 token ↔ 文件词表匹配纪律。
// 两层词表，命中即停：① WU 产出/修改文件集优先（AC4：GET /workunits/:id/changed-files
// 返回 session:start.workUnitId 关联的 file:change 绝对路径——通常是 per-execution
// worktree 内路径，FileRef 按命中边界从绝对路径切出，不强行映射回候选仓）；
// ② 拿不到/WU 层无命中 → 降级候选集词表（#281 file-vocabulary）。
// 两层守同一匹配纪律：恰好唯一命中才染 chip，多条命中（含 basename 不唯一）保持纯文本。
import type { ChannelFileVocabulary, FileRef } from '../api/channel';
import { stripTrailingSlashes } from '@dommaker/studio-shared/web';

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
 * WU 文件集命中 → FileRef：按命中边界从绝对路径切出 repo/path
 * （调用方保证 abs === token 或 abs 以 '/' + token 结尾）。
 * worktree 绝对路径不映射回候选仓——chip 复制/tooltip 给的是 agent 实际写的路径。
 */
function fileRefFromAbsPath(abs: string, token: string): FileRef {
  const idx = abs.length - token.length;
  if (idx <= 0) {
    // token === abs（绝对路径全写）：repo 取目录、path 取 basename
    const slash = abs.lastIndexOf('/');
    return slash > 0
      ? { repo: abs.slice(0, slash), path: abs.slice(slash + 1) }
      : { repo: '', path: abs };
  }
  return { repo: abs.slice(0, idx - 1), path: abs.slice(idx) };
}

/**
 * token（trim 后）满足 path === token 或 path 以 '/' + token 结尾（路径边界后缀）即候选；
 * 恰好命中唯一一条才返回 FileRef，否则 null。空 token / 含换行跳过。
 *
 * 两层词表（#285 AC4）：wuFiles（WU 产出/修改文件集，绝对路径）非空时优先匹配——
 * 唯一命中直接染；多条命中 = 歧义，保持纯文本（不回退词表，同一匹配纪律）；
 * 无命中才降级 vocabulary 候选集词表。
 */
export function matchFileRefToken(
  token: string,
  vocabulary: ChannelFileVocabulary,
  wuFiles?: string[],
): FileRef | null {
  const t = token.trim();
  if (!t || t.includes('\n') || t.includes('\r')) return null;
  if (wuFiles && wuFiles.length > 0) {
    let wuHit: string | null = null;
    let ambiguous = false;
    for (const abs of wuFiles) {
      if (abs === t || abs.endsWith('/' + t)) {
        if (wuHit) { ambiguous = true; break; } // 第二条命中 → 歧义
        wuHit = abs;
      }
    }
    if (ambiguous) return null;
    if (wuHit) return fileRefFromAbsPath(wuHit, t);
  }
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
  return `${stripTrailingSlashes(ref.repo)}/${ref.path.replace(/^\/+/, '')}`;
}
