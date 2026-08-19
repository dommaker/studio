// #277（决策 #248 D5）：remarkMentions 插件单测——文本节点 @name 拆成 mention 链接节点；
// code/inlineCode/link/html 不动（代码里的 @ 不是 mention）。
import { describe, it, expect } from 'vitest';
import { remarkMentions } from '../remarkMentions';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const run = (tree: MdNode) => {
  remarkMentions()(tree);
  return tree;
};

describe('remarkMentions — mdast 文本节点拆分（#277）', () => {
  it('文本中的 @name 拆为 mention 链接节点（url = mention:<name>）', () => {
    const tree = run({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '请 @pm 看' }] }],
    });
    expect(tree.children![0].children).toEqual([
      { type: 'text', value: '请 ' },
      { type: 'link', url: 'mention:pm', children: [{ type: 'text', value: '@pm' }] },
      { type: 'text', value: ' 看' },
    ]);
  });

  it('code / inlineCode 内的 @ 不动', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'code', value: 'const x = "@block";' },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: '@inline' }] },
      ],
    });
    expect(tree.children![0].value).toBe('const x = "@block";');
    expect(tree.children![1].children![0]).toEqual({ type: 'inlineCode', value: '@inline' });
  });

  it('链接节点内部不递归（不造嵌套链接）', () => {
    const tree = run({
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [{ type: 'link', url: 'https://x.com', children: [{ type: 'text', value: '@pm 的文档' }] }],
      }],
    });
    expect(tree.children![0].children![0].children).toEqual([{ type: 'text', value: '@pm 的文档' }]);
  });

  it('无 mention 的文本节点原样保留', () => {
    const tree = run({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '没有提及' }] }],
    });
    expect(tree.children![0].children).toEqual([{ type: 'text', value: '没有提及' }]);
  });

  it('邮箱不误拆', () => {
    const tree = run({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '发到 a@b.com' }] }],
    });
    expect(tree.children![0].children).toEqual([{ type: 'text', value: '发到 a@b.com' }]);
  });
});
