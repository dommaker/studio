// Smoke test — AC-E3: ConvertToTaskDialog renders without crashing
// #292: 标题预填三态 — 原文派生预填 / suggestTask 覆盖 / 失败或为空时兜底保留；预填值可编辑
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockSuggestTask } = vi.hoisted(() => ({
  mockSuggestTask: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: vi.fn().mockResolvedValue({ data: { data: [] } }),
    discoverProjects: vi.fn().mockResolvedValue({ data: { data: [] } }),
    suggestTask: mockSuggestTask,
    convertToTask: vi.fn(),
  },
}));

import { ConvertToTaskDialog } from '../ConvertToTaskDialog';

function renderDialog(messageContent: string) {
  render(
    <ConvertToTaskDialog
      open={true}
      onClose={() => {}}
      messageId="msg-1"
      channelId="ch-1"
      messageContent={messageContent}
      onConverted={() => {}}
    />
  );
  return screen.getByPlaceholderText('任务标题') as HTMLInputElement;
}

describe('ConvertToTaskDialog', () => {
  beforeEach(() => {
    mockSuggestTask.mockReset().mockResolvedValue({ data: { data: {} } });
  });

  it('renders nothing when open=false', () => {
    const { container } = render(
      <ConvertToTaskDialog
        open={false}
        onClose={() => {}}
        messageId="msg-1"
        channelId="ch-1"
        messageContent="test"
        onConverted={() => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders dialog when open=true', () => {
    renderDialog('fix the bug');
    expect(screen.getByText('转为任务')).toBeTruthy();
    expect(screen.getByText('创建任务')).toBeTruthy();
  });

  it('打开对话框即见原文派生的默认标题（首行）', () => {
    const title = renderDialog('修复登录 bug\n详细描述第二行');
    expect(title.value).toBe('修复登录 bug');
  });

  it('默认标题截断到约 50 字', () => {
    const title = renderDialog('长'.repeat(80));
    expect(title.value).toBe('长'.repeat(50));
  });

  it('suggestTask 返回 title 时覆盖预填值', async () => {
    mockSuggestTask.mockResolvedValue({ data: { data: { title: 'LLM 建议标题' } } });
    const title = renderDialog('修复登录 bug');
    expect(title.value).toBe('修复登录 bug');
    await waitFor(() => expect(title.value).toBe('LLM 建议标题'));
  });

  it('suggestTask 返回空时保留原文派生兜底', async () => {
    const title = renderDialog('修复登录 bug');
    await waitFor(() => expect(mockSuggestTask).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('正在获取建议...')).toBeNull());
    expect(title.value).toBe('修复登录 bug');
  });

  it('suggestTask 失败时保留原文派生兜底', async () => {
    mockSuggestTask.mockRejectedValue(new Error('network down'));
    const title = renderDialog('修复登录 bug');
    await waitFor(() => expect(screen.queryByText('正在获取建议...')).toBeNull());
    expect(title.value).toBe('修复登录 bug');
  });

  it('预填标题可自由编辑', () => {
    const title = renderDialog('修复登录 bug');
    fireEvent.change(title, { target: { value: '用户改的标题' } });
    expect(title.value).toBe('用户改的标题');
  });

  it('首行为空时取首个非空行兜底', () => {
    const title = renderDialog('\n\n  实际内容在这  ');
    expect(title.value).toBe('实际内容在这');
  });

  it('用户已编辑标题时，suggestTask 建议返回不覆盖用户输入', async () => {
    let resolveSuggest!: (v: unknown) => void;
    mockSuggestTask.mockReturnValue(new Promise(res => { resolveSuggest = res; }));
    const title = renderDialog('修复登录 bug');
    fireEvent.change(title, { target: { value: '用户改的标题' } });
    resolveSuggest({ data: { data: { title: 'LLM 建议标题' } } });
    await waitFor(() => expect(screen.queryByText('正在获取建议...')).toBeNull());
    expect(title.value).toBe('用户改的标题');
  });
});
