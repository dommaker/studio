// #277（决策 #248 D5）：remark 插件——把 mdast 文本节点中的 @name 拆成 mention 链接节点
//（url = `mention:<name>`），MarkdownBody 的 a 渲染器据此染 chip。
// 代码（围栏/行内）、链接、原始 HTML 节点不动——代码里的 @ 不是 mention。
// 本地最小 mdast 结构类型：不引 @types/mdast（非直接依赖，pnpm 严格 node_modules 解析不到）。
import { MENTION_RE } from './mentions';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const SKIP_TYPES = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'definition']);

function splitTextNode(node: MdNode): MdNode[] {
  const text = node.value ?? '';
  const out: MdNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({
      type: 'link',
      url: `mention:${m[1]}`,
      children: [{ type: 'text', value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [node];
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

function transform(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      next.push(...splitTextNode(child));
    } else {
      if (!SKIP_TYPES.has(child.type)) transform(child);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkMentions() {
  return (tree: MdNode) => {
    transform(tree);
  };
}
