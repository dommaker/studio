// Markdown 正文渲染 — 阅览室详情页正文方案（2026-07-31 §10 任务 4b；lazy 按需加载，fallback 为原 plain-text 形态）
//（另一消费方 DocReaderDrawer 已随 #149 document-store 退役删除）
// react-markdown + remark-gfm：默认不渲染原始 HTML（agent 产出内容按不可信输入处理，无需 DOMPurify）。
// 主题经 components 映射到 u-* 类 / CSS 变量（--bg-tertiary/--border-subtle 等），暗色天然适配——
// 不引 @tailwindcss/typography（prose 体系与 style-guide 的 u-* 类冲突，全站未装该插件）。
// [[wiki 链接]] 预处理为 /library/<title> 站内链接（沿用原 WikiDocPage renderContent 语义），
// 由 a 渲染器识别站内路径转 router Link；外链新标签页打开。
// #271（决策 #248 D4）参数化剥离，供频道 agent 消息复用：
//   wikiLinks=false 关掉阅览室专属预处理；codeCopy 给围栏代码块加复制按钮；
//   renderInlineCode 为 inline-code 自定义渲染挂载点（频道文件 chip 经此接入）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { copyText } from '../../utils/clipboard';

/** [[X]] → [X](/library/<encodeURIComponent(X)>)（在 markdown 解析前预处理；a 渲染器再转 router Link） */
function preprocessWikiLinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, (_, raw: string) => {
    const t = raw.trim();
    return `[${t}](/library/${encodeURIComponent(t)})`;
  });
}

/** 从 ReactNode 树提取纯文本（复制代码块内容用） */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

const LINK_CLASS = 'u-accent underline';
const COPIED_FEEDBACK_MS = 1500;

const PRE_CLASS = 'p-3 rounded overflow-x-auto text-xs font-mono my-2';
const PRE_STYLE = { background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' } as const;

/** 带「复制」按钮的围栏代码块容器（codeCopy 开启时替换 pre 渲染器） */
function CopyablePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = () => {
    // react-markdown 的围栏代码内容以 \n 收尾，复制时去掉
    void copyText(extractText(children).replace(/\n$/, ''));
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <div style={{ position: 'relative' }}>
      <pre className={PRE_CLASS} style={PRE_STYLE}>
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: 10,
          right: 6,
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-tertiary)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

interface ComponentsOptions {
  codeCopy: boolean;
  renderInlineCode?: (text: string) => ReactNode;
}

function createComponents({ codeCopy, renderInlineCode }: ComponentsOptions): Components {
  return {
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
      // #271: 行内 code 自定义渲染挂载点（返回 null/undefined 走默认行内 chip）
      if (renderInlineCode) {
        const custom = renderInlineCode(extractText(children));
        if (custom != null) return <>{custom}</>;
      }
      return (
        <code className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--bg-tertiary)' }}>
          {children}
        </code>
      );
    },
    pre: ({ children }) =>
      codeCopy ? (
        <CopyablePre>{children}</CopyablePre>
      ) : (
        <pre className={PRE_CLASS} style={PRE_STYLE}>
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
}

interface Props {
  content: string;
  className?: string;
  /** [[wiki 链接]] 预处理开关；阅览室缺省 true（行为零变化），频道传 false（#271） */
  wikiLinks?: boolean;
  /** 围栏代码块右上角「复制」按钮；缺省 false，频道 agent 消息开启（#271） */
  codeCopy?: boolean;
  /** inline-code 自定义渲染挂载点：返回非 null 替代默认行内 chip（#285 文件 chip 经此接入） */
  renderInlineCode?: (text: string) => ReactNode;
}

export function MarkdownBody({ content, className, wikiLinks = true, codeCopy = false, renderInlineCode }: Props) {
  const components = useMemo(
    () => createComponents({ codeCopy, renderInlineCode }),
    [codeCopy, renderInlineCode],
  );
  return (
    <div className={`text-sm u-text ${className ?? ''}`} style={{ lineHeight: 1.8 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {wikiLinks ? preprocessWikiLinks(content) : content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownBody;
