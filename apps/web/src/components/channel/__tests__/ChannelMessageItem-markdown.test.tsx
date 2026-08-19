// #271（决策 #248 D4）：agent 消息 Markdown 渲染 + 代码块复制按钮；
// 人类消息保持纯文本 pre-wrap；wiki-link 预处理在频道侧关闭；#285 文件 chip 不回归。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelFileVocabulary, ChannelMessage } from '../../../api/channel';
import { ChannelMessageItem } from '../ChannelMessageItem';

const mockWriteText = vi.hoisted(() => vi.fn());

const agentMsg = (content: string): ChannelMessage => ({
  id: 'm1',
  channelId: 'ch1',
  authorType: 'agent',
  agentName: 'dev-agent',
  content,
  createdAt: '2026-08-19T00:00:00.000Z',
});

const renderItem = (message: ChannelMessage, fileVocabulary?: ChannelFileVocabulary) =>
  render(
    <MemoryRouter>
      <ChannelMessageItem message={message} onAction={vi.fn()} fileVocabulary={fileVocabulary} />
    </MemoryRouter>,
  );

describe('ChannelMessageItem — agent 消息 Markdown 渲染（#271）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  it('标题/列表/表格/代码块正确成结构', () => {
    const { container } = renderItem(
      agentMsg('# 日报\n\n- 完成 A\n- 完成 B\n\n| 项 | 状态 |\n| --- | --- |\n| 构建 | 绿 |\n\n```ts\nconst a = 1;\n```'),
    );
    expect(screen.getByRole('heading', { level: 1, name: '日报' })).toBeTruthy();
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByText('构建').tagName).toBe('TD');
    const code = screen.getByText(/const a = 1;/);
    expect(code.closest('pre')).not.toBeNull();
  });

  it('raw HTML 不执行，按文本原样输出', () => {
    const { container } = renderItem(agentMsg('正文 <b>html</b> <script>alert(1)</script>'));
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<b>html</b>');
  });

  it('代码块带复制按钮：点击写入剪贴板并反馈「已复制」', async () => {
    renderItem(agentMsg('```bash\npnpm test\n```'));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith('pnpm test'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('[[wiki 链接]] 在频道不成链接（wiki-link 预处理关闭）', () => {
    const { container } = renderItem(agentMsg('参见 [[CONTEXT]]'));
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('参见 [[CONTEXT]]');
  });

  it('inline-code 命中文件词表仍染 FileRefChip（#285 不回归）', () => {
    const vocab: ChannelFileVocabulary = {
      repos: [{ repo: '/repo/studio', files: ['src/index.ts'] }],
    };
    renderItem(agentMsg('改了 `src/index.ts`'), vocab);
    expect(screen.getByRole('button', { name: 'src/index.ts' })).toBeTruthy();
  });
});

describe('ChannelMessageItem — 人类消息保持纯文本（#271）', () => {
  it('输入什么显示什么：不渲染标题/代码块/复制按钮', () => {
    const content = '# 不是标题\n\n```ts\nconst a = 1;\n```';
    const { container } = renderItem({ ...agentMsg(content), authorType: 'human' });
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
    expect(container.querySelector('.mc-msg-body')?.textContent).toBe(content);
  });
});
