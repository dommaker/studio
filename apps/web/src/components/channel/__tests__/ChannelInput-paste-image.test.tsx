// ChannelInput — 2026-09 截图粘贴/上传：onPaste 剪贴板图片 → 上传 → 光标处插入 markdown 图片语法；
// 图片选择按钮同路径；超限/类型不符/上传失败 toast 反馈且不动草稿。
// 独立文件（同 ChannelInput-send-failure 的隔离理由）：避免与其他用例的 focus/DOM 残留串扰。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockUpload = vi.hoisted(() => vi.fn());

vi.mock('../../../api/channel', () => ({
  channelApi: { listAgents: vi.fn(), uploadAttachment: mockUpload },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';

const ATT_URL = '/api/v1/channels/ch-1/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';

function setup() {
  const { container } = render(
    <ChannelInput onSend={vi.fn()} sending={false} channelId="ch-1" />,
  );
  const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  return { textarea, fileInput, container };
}

function pngFile(name = 'shot.png', size = 4): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

describe('ChannelInput — 截图粘贴/上传（2026-09）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 清理残留 toast（duration 4s，跨用例会污染 getByText）
    document.querySelector('#toast-container')?.replaceChildren();
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
    mockUpload.mockResolvedValue({ data: { success: true, data: { id: 'att-1', url: ATT_URL, size: 4 } } });
  });

  it('粘贴剪贴板图片 → 调上传 API → 草稿插入 markdown 图片语法', async () => {
    const { textarea } = setup();
    fireEvent.paste(textarea, { clipboardData: { files: [pngFile()], types: ['Files'] } });

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload.mock.calls[0][0]).toBe('ch-1');
    expect(mockUpload.mock.calls[0][1].mime).toBe('image/png');
    expect(mockUpload.mock.calls[0][1].dataBase64).toBeTruthy();
    await waitFor(() => expect(textarea.value).toBe(`![shot.png](${ATT_URL})`));
  });

  it('粘贴纯文本（无文件）→ 不拦默认行为、不上传', () => {
    const { textarea } = setup();
    fireEvent.paste(textarea, { clipboardData: { files: [], types: ['text/plain'] } });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('上传中显示占位态「上传图片中…」，完成后消失', async () => {
    let resolveUpload: (v: unknown) => void;
    mockUpload.mockReturnValue(new Promise(r => { resolveUpload = r; }));
    const { textarea } = setup();
    fireEvent.paste(textarea, { clipboardData: { files: [pngFile()], types: ['Files'] } });

    expect(await screen.findByText('上传图片中…')).toBeTruthy();
    resolveUpload!({ data: { success: true, data: { id: 'att-1', url: ATT_URL, size: 4 } } });
    await waitFor(() => expect(screen.queryByText('上传图片中…')).toBeNull());
    await waitFor(() => expect(textarea.value).toContain(ATT_URL));
  });

  it('上传失败 → toast + 草稿不丢', async () => {
    mockUpload.mockRejectedValue(new Error('network down'));
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: '既有草稿' } });
    fireEvent.paste(textarea, { clipboardData: { files: [pngFile()], types: ['Files'] } });

    expect(await screen.findByText('图片上传失败，请重试')).toBeTruthy();
    expect(textarea.value).toBe('既有草稿');
  });

  it('超过 5MB → toast「图片超过 5MB 上限」，不调上传 API', async () => {
    const { textarea } = setup();
    const big = pngFile('big.png', 5 * 1024 * 1024 + 1);
    fireEvent.paste(textarea, { clipboardData: { files: [big], types: ['Files'] } });

    expect(await screen.findByText('图片超过 5MB 上限')).toBeTruthy();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('类型不符（image/bmp）→ toast，不调上传 API', async () => {
    const { textarea } = setup();
    const bmp = new File([new Uint8Array(4)], 'x.bmp', { type: 'image/bmp' });
    fireEvent.paste(textarea, { clipboardData: { files: [bmp], types: ['Files'] } });

    expect(await screen.findByText('不支持的图片类型（仅 png/jpg/jpeg/gif/webp）')).toBeTruthy();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('图片选择按钮 → 隐藏 input 选文件 → 同样上传并插入 markdown', async () => {
    const { textarea, fileInput } = setup();
    fireEvent.click(screen.getByRole('button', { name: '上传图片' }));
    fireEvent.change(fileInput, { target: { files: [pngFile('pick.jpg')] } });

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textarea.value).toBe(`![pick.jpg](${ATT_URL})`));
  });
});
