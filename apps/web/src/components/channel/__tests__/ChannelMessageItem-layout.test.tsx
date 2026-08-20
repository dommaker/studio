// #277（决策 #248 D1/D2/D3/D5）：消息分侧布局——人右轻气泡 / agent 左文档流 /
// 系统播报（Studio）居中淡色一行 / 卡片全宽；mention chip 双侧正则染色；
// compact（5min 同作者连续合并）省略重复头但保留动作。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelMessage } from '../../../api/channel';
import { ChannelMessageItem } from '../ChannelMessageItem';

const base: ChannelMessage = {
  id: 'm-1',
  channelId: 'ch-1',
  authorType: 'agent',
  agentName: 'dev-agent',
  content: '正文内容',
  replyToId: null,
  meta: '{}',
  createdAt: '2026-08-19T00:00:00.000Z',
};

const renderItem = (message: ChannelMessage, extra: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <ChannelMessageItem message={message} onAction={vi.fn()} {...extra} />
    </MemoryRouter>,
  );

const rootOf = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-message-id="${id}"]`) as HTMLElement;

describe('ChannelMessageItem — 分侧布局（#277 D1）', () => {
  it('人类消息右侧轻气泡：mc-msg-human + mc-bubble 正文', () => {
    const { container } = renderItem({ ...base, authorType: 'human', agentName: undefined });
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-human')).toBe(true);
    expect(root.classList.contains('mc-msg-agent')).toBe(false);
    expect(root.querySelector('.mc-msg-body')!.classList.contains('mc-bubble')).toBe(true);
  });

  it('agent 消息左侧文档流：mc-msg-agent，正文无气泡', () => {
    const { container } = renderItem(base);
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-agent')).toBe(true);
    expect(root.classList.contains('mc-msg-human')).toBe(false);
    expect(root.querySelector('.mc-msg-body')!.classList.contains('mc-bubble')).toBe(false);
  });

  it('卡片消息不参与分侧：无 human/agent/system 侧类，带 mc-msg-card 全宽标记', () => {
    const { container } = renderItem({
      ...base,
      meta: {
        cardType: 'knowledge_proposal',
        status: 'ready',
        cardData: { entries: [{ id: 'k-1', title: 't', type: 'pitfall' }] },
      },
    });
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-card')).toBe(true);
    expect(root.classList.contains('mc-msg-human')).toBe(false);
    expect(root.classList.contains('mc-msg-agent')).toBe(false);
    expect(root.classList.contains('mc-msg-system')).toBe(false);
  });
});

describe('ChannelMessageItem — 头部规则（#277 D2）', () => {
  it('agent 侧完整头：头像 + @名 + 时间戳', () => {
    const { container } = renderItem(base);
    const root = rootOf(container, 'm-1');
    expect(root.querySelector('.mc-avatar')).not.toBeNull();
    expect(root.querySelector('.mc-author')!.textContent).toBe('@dev-agent');
    expect(root.querySelector('.mc-time')).not.toBeNull();
  });

  it('人类侧头像 + 时间戳，无作者名（名由登录态可知，D2 不列）', () => {
    const { container } = renderItem({ ...base, authorType: 'human', agentName: undefined });
    const root = rootOf(container, 'm-1');
    expect(root.querySelector('.mc-avatar')).not.toBeNull();
    expect(root.querySelector('.mc-time')).not.toBeNull();
    expect(root.querySelector('.mc-author')).toBeNull();
  });

  it('compact（连续合并）省略重复头：无头像/时间，回复动作仍可用', () => {
    const onReply = vi.fn();
    const { container } = renderItem(base, { compact: true, onReply });
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-compact')).toBe(true);
    expect(root.querySelector('.mc-msg-head')).toBeNull();
    expect(root.querySelector('.mc-avatar')).toBeNull();
    expect(root.querySelector('.mc-time')).toBeNull();
    // 动作不随头一起消失
    fireEvent.click(screen.getByLabelText('回复消息'));
    expect(onReply).toHaveBeenCalledWith(base);
  });
});

describe('ChannelMessageItem — 系统播报居中（#277 D3）', () => {
  const studioMsg = (extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
    ...base,
    agentName: 'Studio',
    content: 'WorkUnit 已完成',
    ...extra,
  });

  it('Studio 系统播报：mc-msg-system，无头像无作者头', () => {
    const { container } = renderItem(studioMsg());
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-system')).toBe(true);
    expect(root.querySelector('.mc-avatar')).toBeNull();
    expect(root.querySelector('.mc-msg-head')).toBeNull();
    expect(screen.getByText('WorkUnit 已完成')).toBeTruthy();
  });

  it('NEED_INPUT 等待回复的 Studio 消息不判系统（保留 agent 头与回复框）', () => {
    const { container } = renderItem(studioMsg({ content: '选哪个工程？' }), {
      waitingForInput: true,
      onInlineReply: vi.fn(),
    });
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-system')).toBe(false);
    expect(root.classList.contains('mc-msg-agent')).toBe(true);
    expect(root.querySelector('.mc-avatar')).not.toBeNull();
    expect(screen.getByText('等待回复')).toBeTruthy();
  });

  it('带卡片的 Studio 消息不判系统（卡片全宽分支优先）', () => {
    const { container } = renderItem(studioMsg({
      meta: {
        cardType: 'knowledge_proposal',
        status: 'ready',
        cardData: { entries: [{ id: 'k-1', title: 't', type: 'pitfall' }] },
      },
    }));
    const root = rootOf(container, 'm-1');
    expect(root.classList.contains('mc-msg-system')).toBe(false);
    expect(root.classList.contains('mc-msg-card')).toBe(true);
  });
});

describe('ChannelMessageItem — mention chip（#277 D5，零存储模型变更）', () => {
  it('人类消息纯文本内 @name 渲染为 chip，其余文本原样', () => {
    const { container } = renderItem({
      ...base, authorType: 'human', agentName: undefined, content: '找 @pm 看一下这个',
    });
    const chip = container.querySelector('.mc-mention-chip');
    expect(chip!.textContent).toBe('@pm');
    expect(rootOf(container, 'm-1').querySelector('.mc-msg-body')!.textContent).toBe('找 @pm 看一下这个');
  });

  it('agent Markdown 正文内 @name 也染 chip', () => {
    const { container } = renderItem({ ...base, content: '请 @librarian 补充上下文' });
    const chip = container.querySelector('.mc-mention-chip');
    expect(chip!.textContent).toBe('@librarian');
  });

  it('邮箱不误染：a@b.com 不出 chip', () => {
    const { container } = renderItem({
      ...base, authorType: 'human', agentName: undefined, content: '发到 a@b.com 即可',
    });
    expect(container.querySelector('.mc-mention-chip')).toBeNull();
    expect(rootOf(container, 'm-1').querySelector('.mc-msg-body')!.textContent).toBe('发到 a@b.com 即可');
  });

  it('agent 代码（围栏/行内）内的 @name 不染 chip', () => {
    const { container } = renderItem({
      ...base,
      content: '正文 @pm\n\n`@inline`\n\n```ts\nconst x = "@block";\n```',
    });
    const chips = container.querySelectorAll('.mc-mention-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('@pm');
  });

  it('中文 agent 名同样染 chip（与后端 detectMention 的 Unicode 口径一致）', () => {
    const { container } = renderItem({
      ...base, authorType: 'human', agentName: undefined, content: '@图书管理员 查一下',
    });
    const chip = container.querySelector('.mc-mention-chip');
    expect(chip!.textContent).toBe('@图书管理员');
  });
});
