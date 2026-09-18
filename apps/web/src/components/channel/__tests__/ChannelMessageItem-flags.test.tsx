// ChannelMessageItem — #547：per-message 派生 flags 的消息项级断言（自页面分册迁移/补齐）——
// highlight（#279 顶栏待办定位）→ mc-msg-highlight；fresh（批次 E-3 SSE 新到达渐隐）→ mc-msg-new；
// focused（Phase 3 AC5 键盘导航焦点环）→ mc-msg-focused。三 flag 互不染指，缺省全不带。
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
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

const renderItem = (flags: { highlight?: boolean; fresh?: boolean; focused?: boolean } = {}) =>
  render(
    <MemoryRouter>
      <ChannelMessageItem message={base} {...flags} />
    </MemoryRouter>,
  );

const rootClass = (container: HTMLElement) =>
  (container.querySelector('[data-message-id="m-1"]') as HTMLElement).className;

describe('ChannelMessageItem — per-message flags（#547 消息项级）', () => {
  it('highlight → mc-msg-highlight（顶栏待办 chip 定位高亮）', () => {
    const { container } = renderItem({ highlight: true });
    expect(rootClass(container)).toContain('mc-msg-highlight');
    expect(rootClass(container)).not.toContain('mc-msg-new');
    expect(rootClass(container)).not.toContain('mc-msg-focused');
  });

  it('fresh → mc-msg-new（SSE 新到达渐隐高亮）', () => {
    const { container } = renderItem({ fresh: true });
    expect(rootClass(container)).toContain('mc-msg-new');
    expect(rootClass(container)).not.toContain('mc-msg-highlight');
  });

  it('focused → mc-msg-focused（j/k 键盘导航焦点环）', () => {
    const { container } = renderItem({ focused: true });
    expect(rootClass(container)).toContain('mc-msg-focused');
    expect(rootClass(container)).not.toContain('mc-msg-highlight');
  });

  it('缺省三 flag 全不带', () => {
    const { container } = renderItem();
    const cls = rootClass(container);
    expect(cls).not.toContain('mc-msg-highlight');
    expect(cls).not.toContain('mc-msg-new');
    expect(cls).not.toContain('mc-msg-focused');
  });
});
