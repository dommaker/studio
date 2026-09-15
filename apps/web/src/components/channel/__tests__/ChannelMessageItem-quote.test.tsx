// ChannelMessageItem — channel 上下游优化 Phase 1（AC1，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// quote 引用块可点击定位上游消息——提供 onQuoteClick 且父消息已加载时 button 化；否则保持纯 div 展示。
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// 卡片子组件与本测试无关，避免其内部 API 依赖
vi.mock('../RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelMessageItem } from '../ChannelMessageItem';
import { ChannelMessageEnvProvider } from '../ChannelMessageEnv';
import type { ChannelMessage } from '../../../api/channel';

const parentMessage: ChannelMessage = {
  id: 'm-parent',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'pm-agent',
  content: '上游结论：用方案 A',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
};

const replyMessage: ChannelMessage = {
  id: 'm-reply',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'human',
  content: '同意，就这么办',
  replyToId: 'm-parent',
  meta: '{}',
  createdAt: new Date().toISOString(),
};

const findMessage = (id: string) => (id === parentMessage.id ? parentMessage : undefined);

describe('ChannelMessageItem — quote 引用块点击定位（Phase 1 / AC1）', () => {
  it('提供 onQuoteClick 且父消息已加载 → quote 渲染为 button，点击回调带父消息 id', () => {
    const onQuoteClick = vi.fn();
    const { container } = render(
      <ChannelMessageEnvProvider value={{ onAction: vi.fn(), findMessage, onQuoteClick }}>
        <ChannelMessageItem message={replyMessage} />
      </ChannelMessageEnvProvider>,
    );
    const quote = container.querySelector('.mc-quote');
    expect(quote?.tagName).toBe('BUTTON');
    fireEvent.click(quote!);
    expect(onQuoteClick).toHaveBeenCalledTimes(1);
    expect(onQuoteClick).toHaveBeenCalledWith('m-parent');
  });

  it('未提供 onQuoteClick → quote 保持纯 div 展示（不可点）', () => {
    const { container } = render(
      <ChannelMessageEnvProvider value={{ onAction: vi.fn(), findMessage }}>
        <ChannelMessageItem message={replyMessage} />
      </ChannelMessageEnvProvider>,
    );
    const quote = container.querySelector('.mc-quote');
    expect(quote).not.toBeNull();
    expect(quote?.tagName).toBe('DIV');
  });

  it('父消息掉出已加载分页（findMessage 未命中）→ 不渲染 quote', () => {
    const onQuoteClick = vi.fn();
    const { container } = render(
      <ChannelMessageEnvProvider value={{ onAction: vi.fn(), findMessage: () => undefined, onQuoteClick }}>
        <ChannelMessageItem message={replyMessage} />
      </ChannelMessageEnvProvider>,
    );
    expect(container.querySelector('.mc-quote')).toBeNull();
  });
});
