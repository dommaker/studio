// messageImages — 2026-09 截图粘贴：纯文本侧消息正文 附件图片 + mention chip 拆分
import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { renderWithMentionsAndImages } from '../messageImages';
import { useAuthStore } from '../../stores/authStore';

const ATT = '/api/v1/channels/ch1/attachments/a-1.png';

function renderNodes(text: string) {
  return render(<>{renderWithMentionsAndImages(text)}</>);
}

describe('renderWithMentionsAndImages', () => {
  afterEach(() => {
    useAuthStore.setState({ token: null });
  });

  it('附件图片语法 → <img>（src 现拼 token），前后文本保留', () => {
    useAuthStore.setState({ token: 't1' });
    const { container } = renderNodes(`前文\n![截图](${ATT})\n后文`);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`${ATT}?token=t1`);
    expect(img!.getAttribute('alt')).toBe('截图');
    expect(container.textContent).toContain('前文');
    expect(container.textContent).toContain('后文');
  });

  it('@mention 仍染 chip，与图片同内容共存', () => {
    const { container, getByText } = renderNodes(`@dev 看图 ![x](${ATT})`);
    expect(getByText('@dev').className).toContain('mc-mention-chip');
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('无图片语法 → 纯文本（零 img，行为同 renderWithMentions）', () => {
    const { container } = renderNodes('纯文本 @dev 无图');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('纯文本 @dev 无图');
  });

  it('外链图片语法不渲染，原样成文本', () => {
    const { container } = renderNodes('![x](https://example.com/x.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('![x](https://example.com/x.png)');
  });
});
