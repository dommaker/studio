// useImageUpload（#691 自 ChannelInput 抽出）：2026-09 截图粘贴上传——无频道上下文 /
// 类型白名单 / 5MB 上限客户端先拦（toast + 不上传）；成功经 insertSnippet 插入 markdown
// 图片语法（alt 消毒 ]/(/)/换行）；失败 toast 不动草稿；uploadingCount 并发计数归零。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockUploadAttachment, mockToastError } = vi.hoisted(() => ({
  mockUploadAttachment: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: { uploadAttachment: mockUploadAttachment },
}));

vi.mock('../../utils/toast', () => ({
  toast: { error: mockToastError },
}));

import { useImageUpload } from '../useImageUpload';

const png = (name = 'shot.png', size?: number) => {
  const file = new File(['x'], name, { type: 'image/png' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

function setup(opts: { channelId?: string } = { channelId: 'ch-1' }) {
  const insertSnippet = vi.fn();
  const { result } = renderHook(() => useImageUpload({ channelId: opts.channelId, insertSnippet }));
  return { result, insertSnippet };
}

describe('useImageUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadAttachment.mockResolvedValue({ data: { data: { url: '/attachments/a1.png' } } });
  });

  it('无频道上下文 → toast 拦截，不上传', async () => {
    const { result, insertSnippet } = setup({ channelId: undefined });
    await act(async () => { await result.current.uploadImage(png()); });
    expect(mockToastError).toHaveBeenCalledWith('缺少频道上下文，无法上传图片');
    expect(mockUploadAttachment).not.toHaveBeenCalled();
    expect(insertSnippet).not.toHaveBeenCalled();
  });

  it('类型不在白名单 / 超 5MB → toast 拦截，不上传', async () => {
    const { result } = setup();
    await act(async () => { await result.current.uploadImage(new File(['x'], 'a.txt', { type: 'text/plain' })); });
    expect(mockToastError).toHaveBeenCalledWith('不支持的图片类型（仅 png/jpg/jpeg/gif/webp）');
    await act(async () => { await result.current.uploadImage(png('big.png', 5 * 1024 * 1024 + 1)); });
    expect(mockToastError).toHaveBeenCalledWith('图片超过 5MB 上限');
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  it('成功 → base64 上传 + 光标处插入 markdown 图片语法（alt 消毒）；计数归零', async () => {
    const { result, insertSnippet } = setup();
    await act(async () => { await result.current.uploadImage(png('a](b)\n.png')); });
    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
    const [channelId, body] = mockUploadAttachment.mock.calls[0];
    expect(channelId).toBe('ch-1');
    expect(body.mime).toBe('image/png');
    expect(typeof body.dataBase64).toBe('string');
    // alt 消毒：]/(/)/换行剥除 → 'a](b)\n.png' 变 'ab.png'
    expect(insertSnippet).toHaveBeenCalledWith('![ab.png](/attachments/a1.png)');
    expect(result.current.uploadingCount).toBe(0);
  });

  it('上传失败 → toast，不插入片段；计数归零', async () => {
    mockUploadAttachment.mockRejectedValue(new Error('boom'));
    const { result, insertSnippet } = setup();
    await act(async () => { await result.current.uploadImage(png()); });
    expect(mockToastError).toHaveBeenCalledWith('图片上传失败，请重试');
    expect(insertSnippet).not.toHaveBeenCalled();
    expect(result.current.uploadingCount).toBe(0);
  });

  it('handlePaste：剪贴板有图 → 拦默认走上传；无图 → 不拦默认文本粘贴', async () => {
    const { result } = setup();
    const withImg = {
      clipboardData: { files: [png()] },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;
    await act(async () => { result.current.handlePaste(withImg); });
    expect(withImg.preventDefault).toHaveBeenCalled();
    // uploadImage 内部先过 FileReader 异步读 base64，等待上传调用落地
    await waitFor(() => expect(mockUploadAttachment).toHaveBeenCalledTimes(1));

    const noImg = {
      clipboardData: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;
    act(() => { result.current.handlePaste(noImg); });
    expect(noImg.preventDefault).not.toHaveBeenCalled();
    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
  });
});
