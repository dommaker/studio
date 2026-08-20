// #277（决策 #248 D5）：消息正文 @name → mention chip（正则染色，零存储模型变更，mention 保持纯文本）。
// 口径与后端 detectMention 对齐（@ 后 [\p{L}\p{N}_-]+，支持中文名）；
// 前向断言排除紧跟在文字/数字/@ 后的 @（邮箱 a@b.com、@@ 转义不误染）。
import type { ReactNode } from 'react';

export const MENTION_RE = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_-]+)/gu;

/** 纯文本 → ReactNode 序列：@name 片段包成 chip span，其余原样字符串 */
export function renderWithMentions(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={m.index} className="mc-mention-chip">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
