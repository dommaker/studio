// 人类/系统消息正文渲染（纯文本 pre-wrap 侧）：@mention chip + 频道附件图片内联（2026-09）。
// 只识别本系统附件 URL 的 markdown 图片语法（不开放任意外链图——纯文本侧按不可信输入处理）；
// 其余文本段走 renderWithMentions 原语义。agent 侧经 MarkdownBody img 渲染器出图（同 resolveAttachmentSrc）。
import { Fragment, type ReactNode } from 'react';
import { renderWithMentions } from './mentions';
import { resolveAttachmentSrc } from './attachmentUrl';

const IMAGE_MD_RE = /!\[([^\]]*)\]\((\/api\/v1\/channels\/[^)\s]+\/attachments\/[^)\s]+)\)/g;

/** 纯文本 → ReactNode 序列：![alt](附件URL) → <img>，@name → mention chip，其余原样字符串 */
export function renderWithMentionsAndImages(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(IMAGE_MD_RE)) {
    if (m.index > last) {
      out.push(<Fragment key={`t${m.index}`}>{renderWithMentions(text.slice(last, m.index))}</Fragment>);
    }
    out.push(
      <img
        key={`i${m.index}`}
        src={resolveAttachmentSrc(m[2])}
        alt={m[1]}
        className="max-w-full rounded my-2"
      />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(<Fragment key={`t${last}`}>{renderWithMentions(text.slice(last))}</Fragment>);
  }
  return out;
}
