// ChannelInput — 批次A 项1：发送失败回灌（参照 ChannelMessageItem 内嵌回复「失败保留 draft」模式）。
// 独立文件（同 ChannelInput-mention-cursor 的隔离理由）：避免与其他用例的 focus/DOM 残留串扰。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../api/channel', () => ({
  channelApi: { listAgents: vi.fn() },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';

function setup(onSend: ReturnType<typeof vi.fn>) {
  render(<ChannelInput onSend={onSend} sending={false} />);
  const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
  return { textarea };
}

describe('ChannelInput — 发送失败回灌（批次A 项1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理残留 toast（duration 4s，跨用例会污染 getByText）
    document.querySelector('#toast-container')?.replaceChildren(); // 只清子节点——toast.ts 模块级缓存 container 引用，remove 会让后续 toast 挂到游离节点
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  });

  it('发送失败 → 文本回灌输入框 + toast「发送失败，内容已保留」', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network down'));
    const { textarea } = setup(onSend);

    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // 乐观清空先发生
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined));
    // 失败后回灌
    await waitFor(() => expect(textarea.value).toBe('hello world'));
    expect(await screen.findByText('发送失败，内容已保留')).toBeTruthy();
  });

  it('发送成功 → 输入框清空，无 toast', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { textarea } = setup(onSend);

    fireEvent.change(textarea, { target: { value: 'ok' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe(''));
    expect(screen.queryByText('发送失败，内容已保留')).toBeNull();
  });

  it('失败回灌后可编辑重发（重发成功即清空）', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const { textarea } = setup(onSend);

    fireEvent.change(textarea, { target: { value: 'retry me' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('retry me'));

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(textarea.value).toBe(''));
  });
});
