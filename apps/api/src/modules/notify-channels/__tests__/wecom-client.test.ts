/**
 * wecom-client 测试（#525 review 收口：企微 markdown 发送唯一出口）
 *
 * vi.stubGlobal('fetch') 覆盖：
 * - 请求包装：POST + msgtype:markdown 体 + 超时 AbortSignal
 * - 2xx → { ok:true }；非 2xx → { ok:false, status } 不抛（调用方处置）
 * - 网络/超时异常 → 抛错透传
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postWeComMarkdown } from '../wecom-client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postWeComMarkdown', () => {
  it('成功：POST markdown 体，返回 ok:true', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await postWeComMarkdown('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', '**标题**\n正文');

    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      msgtype: 'markdown',
      markdown: { content: '**标题**\n正文' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('非 2xx → { ok:false, status } 不抛（502 处置权在调用方）', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await postWeComMarkdown('https://qyapi.weixin.qq.com/x', 't');

    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('网络/超时异常 → 抛错透传', async () => {
    mockFetch.mockRejectedValue(new Error('aborted'));

    await expect(postWeComMarkdown('https://qyapi.weixin.qq.com/x', 't')).rejects.toThrow('aborted');
  });
});
