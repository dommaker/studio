/**
 * outbound-notify routes tests — 契约驱动迁移（批次 5/7）补测试（原无测试文件）。
 *
 * POST /send：zod 必填/词表校验（400）+ priority 缺省回填 + 统一 `{ data }` 壳 +
 * service 异常 → 500 错误壳。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../notify.service.js', () => ({
  notifyService: { send: mockSend },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } };
});

import routes from '../routes.js';

function getHandler(router: Router, method: string, path: string): Function {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`Handler not found: ${method} ${path}`);
}

function mockRes() {
  const res: Record<string, any> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as any;
}

async function invoke(body: unknown) {
  const handler = getHandler(routes, 'post', '/send');
  const req: Record<string, any> = { body, params: {}, query: {} };
  const res = mockRes();
  await handler(req, res);
  return res;
}

const validBody = { type: 'task-failed', title: 'T', content: 'C' };

beforeEach(() => vi.clearAllMocks());

describe('POST /send', () => {
  it('合法 body → 200 `{ data: { success, message } }`，priority 缺省回填 medium', async () => {
    const res = await invoke(validBody);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { success: true, message: 'Notification sent' } });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ ...validBody, priority: 'medium' }));
  });

  it('缺 type/title/content → 400 错误壳（zod）', async () => {
    for (const body of [
      { title: 'T', content: 'C' },
      { type: 'task-failed', content: 'C' },
      { type: 'task-failed', title: 'T' },
    ]) {
      vi.clearAllMocks();
      const res = await invoke(body);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
      expect(mockSend).not.toHaveBeenCalled();
    }
  });

  it('type 词表外值 → 400（原透传收紧）', async () => {
    const res = await invoke({ ...validBody, type: 'bogus-type' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('priority 词表外值 → 400；词表内值透传', async () => {
    const bad = await invoke({ ...validBody, priority: 'urgent' });
    expect(bad.status).toHaveBeenCalledWith(400);

    const ok = await invoke({ ...validBody, priority: 'high' });
    expect(ok.status).toHaveBeenCalledWith(200);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  it('service 抛错 → 500 错误壳（message = 实际错误消息）', async () => {
    mockSend.mockRejectedValueOnce(new Error('discord down'));
    const res = await invoke(validBody);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({
      error: { code: 'INTERNAL', message: 'discord down' },
    });
  });
});
