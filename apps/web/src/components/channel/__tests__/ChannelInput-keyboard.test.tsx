// ChannelInput — #270（决策 #248 D7 / 走查 F5）composer 键盘三修：
// 1) @弹框打开时 Esc 真正关闭（新增 dismiss 状态，提示文案与行为一致）
// 2) IME 合成守卫：isComposing / keyCode 229 / compositionend 后 10ms 兜底，Enter 不发送
// 3) Enter 长按（e.repeat）不连续发送
// 弹框轻量重绘的 listbox aria 语义也在此覆盖。
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

const popupOpen = (container: HTMLElement) => !!container.querySelector('.mc-mention-popup');

describe('ChannelInput — Esc 关闭弹框（#270）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('Esc 关闭弹框且提示文案回落；残留 @query 不再推导重开', async () => {
    const { textarea, container } = setup();

    fireEvent.change(textarea, { target: { value: '@d' } });
    await screen.findByText('@dev-agent');
    expect(screen.getByText('↑↓ 选择 Enter 确认 Esc 取消')).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(popupOpen(container)).toBe(false);
    // 提示文案与行为一致：弹框关闭后不再显示「Esc 取消」
    expect(screen.queryByText('↑↓ 选择 Enter 确认 Esc 取消')).toBeNull();
    // 内容不被 Esc 改动
    expect(textarea.value).toBe('@d');
  });

  it('Esc 关闭后继续输入表达新意图 → 弹框重开', async () => {
    const { textarea, container } = setup();

    fireEvent.change(textarea, { target: { value: '@d' } });
    await screen.findByText('@dev-agent');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(popupOpen(container)).toBe(false);

    fireEvent.change(textarea, { target: { value: '@de' } });
    await screen.findByText('@dev-agent');
    expect(popupOpen(container)).toBe(true);
  });
});

describe('ChannelInput — IME 守卫（#270）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('isComposing 期间 Enter 不发送', () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('你好');
  });

  it('keyCode 229 的 Enter 不发送', () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('compositionend 后 10ms 内 Enter 兜底不发送，之后恢复发送', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { onSend, textarea } = setup();

      fireEvent.change(textarea, { target: { value: '你好' } });
      fireEvent.compositionEnd(textarea);

      nowSpy.mockReturnValue(1005); // compositionend 后 5ms
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(1020); // compositionend 后 20ms
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('你好', undefined);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('弹框打开时 IME 合成 Enter 不选中候选', async () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: '@d' } });
    await screen.findByText('@dev-agent');
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(textarea.value).toBe('@d');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('ChannelInput — Enter 防连发（#270）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('Enter 长按（e.repeat）不发送', () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('hello');
  });

  it('正常 Enter 发送不受 repeat 守卫影响', () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello', undefined);
  });
});

describe('ChannelInput — mention 弹框 listbox 语义（#270）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('弹框带 role=listbox，候选带 role=option 与 aria-selected', async () => {
    const { textarea, container } = setup();

    fireEvent.change(textarea, { target: { value: '@' } });
    await screen.findByText('@dev-agent');

    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(container.querySelectorAll('[role="option"]')[1].getAttribute('aria-selected')).toBe('true');
  });
});
