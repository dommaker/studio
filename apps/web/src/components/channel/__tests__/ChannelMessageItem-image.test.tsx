// ChannelMessageItem — 2026-09 截图粘贴：人类/系统消息（纯文本 pre-wrap 侧）内联渲染频道附件图片。
// 只识别本系统附件 URL 的 markdown 图片语法（任意外链图不渲染）；mention chip 同内容共存不回归。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelMessage } from '../../../api/channel';
import { ChannelMessageItem } from '../ChannelMessageItem';
import { useAuthStore } from '../../../stores/authStore';

const ATT = '/api/v1/channels/ch1/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';

const humanMsg = (content: string): ChannelMessage => ({
  id: 'm1',
  channelId: 'ch1',
  authorType: 'human',
  content,
  createdAt: '2026-09-11T00:00:00.000Z',
});

const renderItem = (message: ChannelMessage) =>
  render(
    <MemoryRouter>
      <ChannelMessageItem message={message} onAction={vi.fn()} />
    </MemoryRouter>,
  );

describe('ChannelMessageItem — 人类消息附件图片（2026-09）', () => {
  afterEach(() => {
    useAuthStore.setState({ token: null });
  });

  it('附件 markdown 语法 → <img>（src 现拼 ?token=），前后文本与 mention chip 共存', () => {
    useAuthStore.setState({ token: 'tok-xyz' });
    const { container } = renderItem(humanMsg(`@dev 看这个\n![shot](${ATT})\n就是这样`));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`${ATT}?token=tok-xyz`);
    expect(img!.getAttribute('alt')).toBe('shot');
    // 文本段 mention chip 不回归
    expect(screen.getByText('@dev').className).toContain('mc-mention-chip');
    expect(container.textContent).toContain('就是这样');
  });

  it('任意外链图片语法不渲染（纯文本侧按不可信输入处理），原样成文本', () => {
    const { container } = renderItem(humanMsg('![x](https://evil.example/steal.png)'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('![x](https://evil.example/steal.png)');
  });
});
