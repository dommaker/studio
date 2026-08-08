// ChannelInput — mention 弹层基础路径：@ 弹候选、过滤、空格关闭、点击/Enter 插入、发送重置。
// 光标移动重算（f7f05269 核心回归）在 ChannelInput-mention-cursor.test.tsx 独立文件——
// 本文件 insertMention 的 setTimeout 会 focus() textarea，污染 document.activeElement，
// 使 React 合成 onSelect 在同一 jsdom 内静默不派发（与 f7f05269 commit message 记载的串扰一致）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockListAgents } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
  },
}));

import { ChannelInput } from '../ChannelInput';

const mockAgents = [
  { id: 'a1', name: 'dev-agent', description: null, status: 'active' },
  { id: 'a2', name: 'pm-agent', description: null, status: 'active' },
];

function setup() {
  const onSend = vi.fn();
  const { container } = render(<ChannelInput onSend={onSend} sending={false} />);
  const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
  return { onSend, textarea, container };
}

function typeAt(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

const popupOpen = (container: HTMLElement) => !!container.querySelector('.mc-mention-popup');

describe('ChannelInput mention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('输入 @ 弹候选，@dev 过滤，@ 后空格不弹', async () => {
    const { textarea, container } = setup();

    typeAt(textarea, '@');
    await screen.findByText('@dev-agent');
    expect(screen.getByText('@pm-agent')).toBeTruthy();

    typeAt(textarea, '@dev');
    await screen.findByText('@dev-agent');
    expect(screen.queryByText('@pm-agent')).toBeNull();

    typeAt(textarea, '@ dev');
    expect(popupOpen(container)).toBe(false);
  });

  it('点击候选插入 @name + 空格并关闭弹层', async () => {
    const { textarea, container } = setup();

    typeAt(textarea, '@d');
    fireEvent.mouseDown(await screen.findByText('@dev-agent'));

    expect(textarea.value).toBe('@dev-agent ');
    expect(popupOpen(container)).toBe(false);
  });

  it('Enter 插入选中候选', async () => {
    const { textarea } = setup();

    typeAt(textarea, '@pm');
    await screen.findByText('@pm-agent');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea.value).toBe('@pm-agent ');
  });

  it('发送后 content 与 cursorPos 重置', async () => {
    const { onSend, textarea } = setup();

    typeAt(textarea, 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello', undefined);
    expect(textarea.value).toBe('');
    // 重置后再输入 @ 仍能正常弹候选（cursorPos 未停留在旧位置）
    typeAt(textarea, '@');
    await screen.findByText('@dev-agent');
  });
});
