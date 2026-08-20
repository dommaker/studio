// ChannelMessageItem — #270（决策 #248 D7）：NEED_INPUT 内嵌回复框共享 composer 同款
// IME 合成守卫（isComposing / keyCode 229 / compositionend 后 10ms 兜底）+ Enter 防连发。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelMessage } from '../../../api/channel';
import { ChannelMessageItem } from '../ChannelMessageItem';

const message: ChannelMessage = {
  id: 'm1',
  channelId: 'ch1',
  authorType: 'agent',
  agentName: 'dev-agent',
  content: '选择哪个工程？',
  workUnitId: 'wu-1',
  createdAt: '2026-08-19T00:00:00.000Z',
};

function setup() {
  const onInlineReply = vi.fn();
  render(
    <MemoryRouter>
      <ChannelMessageItem
        message={message}
        onAction={vi.fn()}
        waitingForInput
        onInlineReply={onInlineReply}
      />
    </MemoryRouter>,
  );
  const input = screen.getByLabelText('回复 wu-1');
  return { onInlineReply, input };
}

describe('ChannelMessageItem — NEED_INPUT 内嵌回复 IME 守卫（#270）', () => {
  it('isComposing 期间 Enter 不发送', async () => {
    const { onInlineReply, input } = setup();

    fireEvent.change(input, { target: { value: '用 studio' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onInlineReply).not.toHaveBeenCalled();

    // #276：发送后状态置位走 async 微任务，act 包裹 flush
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onInlineReply).toHaveBeenCalledWith(message, '用 studio');
  });

  it('keyCode 229 的 Enter 不发送', () => {
    const { onInlineReply, input } = setup();

    fireEvent.change(input, { target: { value: '用 studio' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onInlineReply).not.toHaveBeenCalled();
  });

  it('compositionend 后 10ms 内 Enter 兜底不发送', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { onInlineReply, input } = setup();

      fireEvent.change(input, { target: { value: '用 studio' } });
      fireEvent.compositionEnd(input);

      nowSpy.mockReturnValue(1005);
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onInlineReply).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(1020);
      // #276：发送后状态置位走 async 微任务，act 包裹 flush
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      expect(onInlineReply).toHaveBeenCalledWith(message, '用 studio');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('Enter 长按（e.repeat）不连续发送', () => {
    const { onInlineReply, input } = setup();

    fireEvent.change(input, { target: { value: '用 studio' } });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    expect(onInlineReply).not.toHaveBeenCalled();
  });
});
