// #285（决策 #249 §5）：agent 消息 inline-code 文件 chip —— 复制绝对路径 / .studio/ 跳阅览室
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockNavigate, mockCompanyList, mockProjectList, mockWriteText } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockCompanyList: vi.fn(),
  mockProjectList: vi.fn(),
  mockWriteText: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../api/company', () => ({
  companyApi: { list: mockCompanyList },
}));

vi.mock('../../../api', () => ({
  projectApi: { list: mockProjectList },
}));

import type { ChannelFileVocabulary, ChannelMessage } from '../../../api/channel';
import { FileRefChip } from '../FileRefChip';
import { ChannelMessageItem } from '../ChannelMessageItem';

const vocab: ChannelFileVocabulary = {
  repos: [
    { repo: '/repo/studio', files: ['src/index.ts', 'src/util.ts', '.studio/CONTEXT.md'] },
    { repo: '/repo/web', files: ['src/util.ts'] },
  ],
};

describe('FileRefChip（#285）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  it('渲染 chip：文本 = token 原文，title = 全路径', () => {
    render(<FileRefChip token="index.ts" fileRef={{ repo: '/repo/studio/', path: 'src/index.ts' }} />);
    const chip = screen.getByRole('button', { name: 'index.ts' });
    expect(chip.getAttribute('title')).toBe('/repo/studio/src/index.ts');
  });

  it('点击复制绝对路径到剪贴板，并短暂反馈「已复制」', async () => {
    render(<FileRefChip token="src/index.ts" fileRef={{ repo: '/repo/studio', path: 'src/index.ts' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts' }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith('/repo/studio/src/index.ts'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('.studio/ 路径点击跳阅览室（repo 尾斜杠归一匹配 project.gitRepo）', async () => {
    mockCompanyList.mockResolvedValue({ data: { data: [{ id: 'co-1' }] } });
    mockProjectList.mockResolvedValue({ data: { data: [{ id: 'PMO-7', gitRepo: '/repo/studio/' }] } });

    render(<FileRefChip token=".studio/CONTEXT.md" fileRef={{ repo: '/repo/studio', path: '.studio/CONTEXT.md' }} />);
    fireEvent.click(screen.getByRole('button', { name: '.studio/CONTEXT.md' }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(`/library/${encodeURIComponent('PMO-7:CONTEXT.md')}`));
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('.studio/ 路径：repo 命中 deliveries[].gitRepo 同样跳阅览室', async () => {
    mockCompanyList.mockResolvedValue({ data: { data: [{ id: 'co-1' }] } });
    mockProjectList.mockResolvedValue({
      data: { data: [{ id: 'PMO-9', gitRepo: null, deliveries: [{ gitRepo: '/repo/studio' }] }] },
    });

    render(<FileRefChip token=".studio/CONTEXT.md" fileRef={{ repo: '/repo/studio', path: '.studio/CONTEXT.md' }} />);
    fireEvent.click(screen.getByRole('button', { name: '.studio/CONTEXT.md' }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(`/library/${encodeURIComponent('PMO-9:CONTEXT.md')}`));
  });

  it('.studio/ 路径：项目解析失败 → 降级复制，不跳不报错', async () => {
    mockCompanyList.mockResolvedValue({ data: { data: [{ id: 'co-1' }] } });
    mockProjectList.mockResolvedValue({ data: { data: [] } });

    render(<FileRefChip token=".studio/CONTEXT.md" fileRef={{ repo: '/repo/studio', path: '.studio/CONTEXT.md' }} />);
    fireEvent.click(screen.getByRole('button', { name: '.studio/CONTEXT.md' }));

    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith('/repo/studio/.studio/CONTEXT.md'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('ChannelMessageItem 集成（#285；#271 起正文走 Markdown 渲染）', () => {
  const base: ChannelMessage = {
    id: 'm1', channelId: 'ch1', authorType: 'agent', agentName: 'dev-agent',
    content: '完成 `src/index.ts` 的修改', createdAt: '2026-08-19T00:00:00.000Z',
  };

  it('agent 消息 + 词表 → 正文命中 token 染 chip', () => {
    render(
      <MemoryRouter>
        <ChannelMessageItem message={base} onAction={vi.fn()} fileVocabulary={vocab} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'src/index.ts' })).toBeTruthy();
  });

  it('人类消息 + 词表 → 正文不动，无 chip', () => {
    const { container } = render(
      <MemoryRouter>
        <ChannelMessageItem message={{ ...base, authorType: 'human' }} onAction={vi.fn()} fileVocabulary={vocab} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.mc-file-chip')).toBeNull();
    expect(screen.getByText('完成 `src/index.ts` 的修改')).toBeTruthy();
  });

  it('agent 消息不传词表 → inline-code 走默认 chip 样式，无文件 chip', () => {
    const { container } = render(
      <MemoryRouter>
        <ChannelMessageItem message={base} onAction={vi.fn()} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.mc-file-chip')).toBeNull();
    const code = container.querySelector('.mc-msg-body code');
    expect(code?.textContent).toBe('src/index.ts');
  });
});
