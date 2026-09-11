// attachmentUrl — 2026-09 截图粘贴：频道附件 URL 判定 + 渲染时现拼 ?token=
import { describe, it, expect, afterEach } from 'vitest';
import { resolveAttachmentSrc, CHANNEL_ATTACHMENT_SRC_RE } from '../attachmentUrl';
import { useAuthStore } from '../../stores/authStore';

describe('resolveAttachmentSrc', () => {
  afterEach(() => {
    useAuthStore.setState({ token: null });
  });

  it('命中频道附件 URL + 有 token → 拼 ?token=', () => {
    useAuthStore.setState({ token: 'tok 1' });
    expect(resolveAttachmentSrc('/api/v1/channels/ch1/attachments/abc.png'))
      .toBe(`/api/v1/channels/ch1/attachments/abc.png?token=${encodeURIComponent('tok 1')}`);
  });

  it('命中但无 token → 原样（由后端鉴权语义决定成败）', () => {
    expect(resolveAttachmentSrc('/api/v1/channels/ch1/attachments/abc.png'))
      .toBe('/api/v1/channels/ch1/attachments/abc.png');
  });

  it('非附件 src（外链/站内其他路径/undefined）→ 原样透传', () => {
    useAuthStore.setState({ token: 'tok' });
    expect(resolveAttachmentSrc('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(resolveAttachmentSrc('/api/v1/channels/ch1/messages')).toBe('/api/v1/channels/ch1/messages');
    expect(resolveAttachmentSrc(undefined)).toBeUndefined();
  });

  it('URL 判定：扩展名白名单（png/jpg/jpeg/gif/webp），exe/svg 不命中', () => {
    expect(CHANNEL_ATTACHMENT_SRC_RE.test('/api/v1/channels/ch1/attachments/a-1.jpeg')).toBe(true);
    expect(CHANNEL_ATTACHMENT_SRC_RE.test('/api/v1/channels/ch1/attachments/a-1.webp')).toBe(true);
    expect(CHANNEL_ATTACHMENT_SRC_RE.test('/api/v1/channels/ch1/attachments/a-1.exe')).toBe(false);
    expect(CHANNEL_ATTACHMENT_SRC_RE.test('/api/v1/channels/ch1/attachments/a-1.svg')).toBe(false);
  });
});
