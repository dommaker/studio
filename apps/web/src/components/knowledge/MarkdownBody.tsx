// Markdown 正文渲染 — 阅览室详情页正文方案（2026-07-31 §10 任务 4b；lazy 按需加载，fallback 为原 plain-text 形态）
//（另一消费方 DocReaderDrawer 已随 #149 document-store 退役删除）
// react-markdown + remark-gfm：默认不渲染原始 HTML（agent 产出内容按不可信输入处理，无需 DOMPurify）。
// 主题经 components 映射到 u-* 类 / CSS 变量（--bg-tertiary/--border-subtle 等），暗色天然适配——
// 不引 @tailwindcss/typography（prose 体系与 style-guide 的 u-* 类冲突，全站未装该插件）。
// [[wiki 链接]] 预处理为 /library/<title> 站内链接（沿用原 WikiDocPage renderContent 语义），
// 由 a 渲染器识别站内路径转 router Link；外链新标签页打开。
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';

/** [[X]] → [X](/library/<encodeURIComponent(X)>)（在 markdown 解析前预处理；a 渲染器再转 router Link） */
function preprocessWikiLinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, raw: string) => {
    const t = raw.trim();
    return `[${t}](/library/${encodeURIComponent(t)})`;
  });
}

const LINK_CLASS = 'u-accent underline';

const components: Components = {
  h1: ({ children }) => <h1 className="text-lg font-bold u-text mt-4 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold u-text mt-4 mb-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold u-text mt-3 mb-1">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium u-text-2 mt-3 mb-1">{children}</h4>,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  a: ({ href, children }) => {
    if (href?.startsWith('/')) {
      return <Link to={href} className={LINK_CLASS}>{children}</Link>;
    }
    return <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>{children}</a>;
  },
  ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="pl-3 my-2 u-text-2" style={{ borderLeft: '2px solid var(--border-subtle)' }}>
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    // v10 无 inline 标记：带语言标注或多行 ⇒ 代码块（样式交给 pre 容器），否则行内 chip
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--bg-tertiary)' }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      className="p-3 rounded overflow-x-auto text-xs font-mono my-2"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => <table className="w-full text-xs my-2 border-collapse">{children}</table>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left u-text-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-3" style={{ border: 0, borderTop: '1px solid var(--border-subtle)' }} />,
  img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className="max-w-full rounded my-2" />,
};

interface Props {
  content: string;
  className?: string;
}

export function MarkdownBody({ content, className }: Props) {
  return (
    <div className={`text-sm u-text ${className ?? ''}`} style={{ lineHeight: 1.8 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {preprocessWikiLinks(content)}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownBody;
