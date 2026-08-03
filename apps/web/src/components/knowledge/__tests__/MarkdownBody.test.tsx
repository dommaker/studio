/**
 * MarkdownBody tests - §10 任务 4b 统一 markdown 渲染
 * 覆盖：标题/列表/行内代码基础渲染、GFM 表格、围栏代码块（pre>code 无行内 chip 样式）、
 *       [[wiki 链接]] → router Link、外链新标签页、原始 HTML 不渲染（不可信输入安全）
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MarkdownBody } from '../MarkdownBody';

const renderBody = (content: string) =>
  render(
    <MemoryRouter>
      <MarkdownBody content={content} />
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

  it('[[wiki 链接]] 预处理为 /wiki/<encodeURIComponent> 的 router Link', () => {
    renderBody('参见 [[设计 文档]] 与 [[SDD]]');
    const withSpace = screen.getByRole('link', { name: '设计 文档' });
    expect(withSpace.getAttribute('href')).toBe(`/wiki/${encodeURIComponent('设计 文档')}`);
    expect(screen.getByRole('link', { name: 'SDD' }).getAttribute('href')).toBe('/wiki/SDD');
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
});
