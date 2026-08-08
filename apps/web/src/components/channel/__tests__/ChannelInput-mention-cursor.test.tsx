// ChannelInput — f7f05269 核心回归：mention 解析由 content + cursorPos 纯派生，
// 光标移动（onSelect）即重算弹层。旧实现在 useMemo 渲染期读 textareaRef 且 memo
// 只依赖 content，光标点击移动不重算、弹层停留在过期状态。
//
// 独立成文件的原因：React 合成 onSelect 在 jsdom 下依赖插件的 activeElement 跟踪；
// 同文件内先跑过 insertMention（其 setTimeout 会 focus() textarea）后 select 事件
// 静默不派发（f7f05269 commit message 已记载此串扰）。本文件不含 insertMention 路径，
// 单独成文件保证 onSelect 探针环境干净。
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

describe('ChannelInput mention 光标重算（f7f05269）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgents } });
  });

  it('光标移出 @query 弹层关闭，移回重算后重新出现', async () => {
    const { container } = render(<ChannelInput onSend={() => {}} sending={false} />);
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    const popupOpen = () => !!container.querySelector('.mc-mention-popup');

    // 输入 'hi @dev'（onChange 把光标写在末尾）→ 弹层出现
    fireEvent.change(textarea, { target: { value: 'hi @dev' } });
    await screen.findByText('@dev-agent');

    // 光标移到 @ 之前（点击路径 → onSelect）：before-cursor 无 @ → 弹层关闭
    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    expect(popupOpen()).toBe(false);

    // 光标移回 @query 内：弹层重算后重新出现
    // （旧实现 memo 只依赖 content，光标移动不重算——此处弹层不会回来）
    textarea.setSelectionRange('hi @dev'.length, 'hi @dev'.length);
    fireEvent.select(textarea);
    await screen.findByText('@dev-agent');
    expect(popupOpen()).toBe(true);
  });
});
