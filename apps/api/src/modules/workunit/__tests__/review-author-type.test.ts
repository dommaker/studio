// A2A §4.4-2 / §8-Q3: review API authorType 校验 —— agent 身份调用一律 403，人类/缺省放行。
// 身份约定：body.authorType 或 x-author-type header；UI/人类调用不发送（或发送 'human'）。
// WorkUnitService mock 掉（router 模块级单例会指向真实 ~/.studio/data），只测路由层契约。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockReviewPassed, mockReviewRejected } = vi.hoisted(() => ({
  mockReviewPassed: vi.fn(),
  mockReviewRejected: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    reviewPassed = mockReviewPassed;
    reviewRejected = mockReviewRejected;
  },
}));

import router from '../workunit.routes.js';

describe('review API authorType 校验（A2A §4.4）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    mockReviewPassed.mockResolvedValue({ id: 'wu-1', status: 'done' });
    mockReviewRejected.mockResolvedValue({ id: 'wu-1', status: 'active' });
    const app = express();
    app.use(express.json());
    app.use('/workunits', router);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/workunits`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  function post(path: string, init?: { body?: unknown; headers?: Record<string, string> }) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  it('review-passed：body authorType=agent → 403，service 未被调用', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed', { body: { authorType: 'agent' } });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
    expect(mockReviewPassed).not.toHaveBeenCalled();
  });

  it('review-passed：x-author-type: agent header → 403', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed', { headers: { 'x-author-type': 'agent' } });
    expect(res.status).toBe(403);
    expect(mockReviewPassed).not.toHaveBeenCalled();
  });

  it('review-passed：authorType=human → 正常执行，落台账 l3（human-confirm）', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed', { body: { authorType: 'human' } });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      kind: 'human-confirm',
      by: expect.any(String),
    }));
  });

  it('review-passed：缺省 authorType（UI/人类调用不发送）→ 正常执行，落台账 l3', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed');
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      kind: 'human-confirm',
      by: expect.any(String),
    }));
  });

  it('review-rejected：agent → 403；human → 正常执行，落台账 l3', async () => {
    mockReviewRejected.mockClear();
    const forbidden = await post('/wu-1/review-rejected', { body: { authorType: 'agent', reason: '不行' } });
    expect(forbidden.status).toBe(403);
    expect(mockReviewRejected).not.toHaveBeenCalled();

    const ok = await post('/wu-1/review-rejected', { body: { authorType: 'human', reason: '重做' } });
    expect(ok.status).toBe(200);
    expect(mockReviewRejected).toHaveBeenCalledWith('wu-1', '重做', expect.objectContaining({
      kind: 'human-confirm',
      by: expect.any(String),
    }));
  });
});
