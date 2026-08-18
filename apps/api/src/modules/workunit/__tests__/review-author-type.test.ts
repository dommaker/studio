// A2A §4.4-2 / §8-Q3: review API authorType 校验 —— agent 身份调用一律 403，人类/缺省放行。
// 身份约定：body.authorType 或 x-author-type header；UI/人类调用不发送（或发送 'human'）。
// WorkUnitService mock 掉（router 模块级单例会指向真实 ~/.studio/data），只测路由层契约。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockReviewPassed, mockReviewRejected, mockTransitionStatus } = vi.hoisted(() => ({
  mockReviewPassed: vi.fn(),
  mockReviewRejected: vi.fn(),
  mockTransitionStatus: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    reviewPassed = mockReviewPassed;
    reviewRejected = mockReviewRejected;
    transitionStatus = mockTransitionStatus;
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
    }), undefined);
  });

  it('review-passed：缺省 authorType（UI/人类调用不发送）→ 正常执行，落台账 l3', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed');
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      kind: 'human-confirm',
      by: expect.any(String),
    }), undefined);
  });

  it('review-passed：#177 body.defaultAssigneeId → 透传 service 第三参（trim 后）', async () => {
    mockReviewPassed.mockClear();
    const res = await post('/wu-1/review-passed', { body: { defaultAssigneeId: ' profile-7 ' } });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      kind: 'human-confirm',
    }), { defaultTaskAssigneeId: 'profile-7' });
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

  // #237：/status 同 human-only 约定 —— agent 一律 403（含 in_review→done 与非终态迁移），
  // human/缺省放行。agent 内部合法迁移走服务层 transitionStatus，不经 REST。
  it('status：body authorType=agent → 403（终态与非终态均拦），service 未被调用', async () => {
    mockTransitionStatus.mockClear();
    const toDone = await post('/wu-1/status', { body: { authorType: 'agent', status: 'done' } });
    expect(toDone.status).toBe(403);
    const json = await toDone.json() as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');

    const toBlocked = await post('/wu-1/status', { body: { authorType: 'agent', status: 'blocked' } });
    expect(toBlocked.status).toBe(403);
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('status：x-author-type: agent header → 403', async () => {
    mockTransitionStatus.mockClear();
    const res = await post('/wu-1/status', {
      headers: { 'x-author-type': 'agent' },
      body: { status: 'done' },
    });
    expect(res.status).toBe(403);
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('status：authorType=human / 缺省 → 正常迁移', async () => {
    mockTransitionStatus.mockClear();
    mockTransitionStatus.mockResolvedValue({ id: 'wu-1', status: 'unassigned' });

    const human = await post('/wu-1/status', { body: { authorType: 'human', status: 'unassigned' } });
    expect(human.status).toBe(200);

    const fallback = await post('/wu-1/status', { body: { status: 'unassigned' } });
    expect(fallback.status).toBe(200);
    expect(mockTransitionStatus).toHaveBeenCalledTimes(2);
    expect(mockTransitionStatus).toHaveBeenCalledWith('wu-1', 'unassigned');
  });
});
