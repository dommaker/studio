/**
 * MarkdownBody tests - §10 任务 4b 统一 markdown 渲染
 * 覆盖：标题/列表/行内代码基础渲染、GFM 表格、围栏代码块（pre>code 无行内 chip 样式）、
 *       [[wiki 链接]] → router Link、外链新标签页、原始 HTML 不渲染（不可信输入安全）
 * #271（决策 #248 D4）：wikiLinks 开关 / codeCopy 复制按钮 / renderInlineCode 挂载点
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MarkdownBody } from '../MarkdownBody';

const renderBody = (content: string, props?: Partial<Parameters<typeof MarkdownBody>[0]>) =>
  render(
    <MemoryRouter>
      <MarkdownBody content={content} {...props} />
    </MemoryRouter>,
  );

describe('MarkdownBody', () => {
  it('基础渲染：标题 / 加粗 / 列表 / 行内代码 chip', () => {
    const { container } = renderBody('# 标题一\n\n正文**加粗**\n\n- 项目一\n- 项目二\n\n用 `useState` 管理');
    expect(screen.getByRole('heading', { level: 1, name: '标题一' })).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    // 行内代码：行内 chip（--bg-tertiary 背景），不在 pre 内
    const inline = screen.getByText('useState');
    expect(inline.tagName).toBe('CODE');
    expect(inline.closest('pre')).toBeNull();
    expect(inline.getAttribute('style')).toContain('--bg-tertiary');
  });

  it('GFM：表格渲染为 table 元素（th/td 带分隔线）', () => {
    const { container } = renderBody('| 名称 | 状态 |\n| --- | --- |\n| 登录 | 完成 |');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(screen.getByText('名称').tagName).toBe('TH');
    expect(screen.getByText('登录').tagName).toBe('TD');
  });

  it('围栏代码块：pre > code 结构，不带行内 chip 样式', () => {
    renderBody('```ts\nconst a = 1;\nconst b = 2;\n```');
    const code = screen.getByText(/const a/);
    expect(code.tagName).toBe('CODE');
    expect(code.closest('pre')).not.toBeNull();
    expect(code.getAttribute('style') ?? '').not.toContain('--bg-tertiary');
  });

  it('[[wiki 链接]] 预处理为 /library/<encodeURIComponent> 的 router Link', () => {
    renderBody('参见 [[设计 文档]] 与 [[SDD]]');
    const withSpace = screen.getByRole('link', { name: '设计 文档' });
    expect(withSpace.getAttribute('href')).toBe(`/library/${encodeURIComponent('设计 文档')}`);
    expect(screen.getByRole('link', { name: 'SDD' }).getAttribute('href')).toBe('/library/SDD');
  });

  it('外链新标签页打开（target=_blank rel=noreferrer）', () => {
    renderBody('[官网](https://example.com)');
    const a = screen.getByRole('link', { name: '官网' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });

  it('原始 HTML 不渲染（agent 产出按不可信输入处理）', () => {
    const { container } = renderBody('正文 <b>html</b> <script>alert(1)</script>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // 原样按文本输出
    expect(container.textContent).toContain('<b>html</b>');
  });

  it('#271：wikiLinks=false 时 [[链接]] 保持字面文本，不转 router Link（频道用法）', () => {
    const { container } = renderBody('参见 [[设计 文档]] 与 [[SDD]]', { wikiLinks: false });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('参见 [[设计 文档]] 与 [[SDD]]');
  });

  it('#271：wikiLinks 缺省 = true，阅览室 [[链接]] 行为零变化', () => {
    renderBody('参见 [[SDD]]');
    expect(screen.getByRole('link', { name: 'SDD' }).getAttribute('href')).toBe('/library/SDD');
  });

  it('#271：codeCopy 开启时围栏代码块带复制按钮，点击写剪贴板并反馈「已复制」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderBody('```ts\nconst a = 1;\nconst b = 2;\n```', { codeCopy: true });
    const btn = screen.getByRole('button', { name: '复制' });
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('#271：codeCopy 缺省关闭，代码块无复制按钮（阅览室行为零变化）', () => {
    renderBody('```ts\nconst a = 1;\n```');
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
  });

  it('#271：renderInlineCode 命中时替换行内 chip，返回 null 走默认样式，块级代码不受影响', () => {
    const { container } = renderBody('看 `src/index.ts` 和 `other.ts`\n\n```ts\nconst a = 1;\n```', {
      renderInlineCode: text =>
        text === 'src/index.ts' ? <button type="button">chip:{text}</button> : null,
    });
    // 命中的 inline-code 被自定义渲染替换
    expect(screen.getByRole('button', { name: 'chip:src/index.ts' })).toBeTruthy();
    // 未命中的 inline-code 走默认行内 chip 样式
    const inline = screen.getByText('other.ts');
    expect(inline.tagName).toBe('CODE');
    expect(inline.closest('pre')).toBeNull();
    // 块级代码不经过 renderInlineCode，仍在 pre 内
    const block = screen.getByText(/const a = 1;/);
    expect(block.closest('pre')).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});
