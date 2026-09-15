// F6-c 证据断链修复路由契约测试：
//  - POST /:id/verify（断点 2）：human-only；service.verifyManually 判别联合 kind →
//    404/400/409/422/200 响应映射（#551 业务下沉后，本层只测 kind→HTTP 翻译；
//    守卫链/台账落写本身由 workunit-api.test.ts 的 verifyManually 直测覆盖）
//  - POST /:id/dispatch-review（断点 3）：human-only；404/400/409 守卫；成功返回 { reviewWorkUnitId }
// WorkUnitService / review-dispatcher 均 mock（router 模块级单例会指向真实 ~/.studio/data），只测路由层契约。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockVerifyManually } = vi.hoisted(() => ({
  mockVerifyManually: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    verifyManually = mockVerifyManually;
  },
}));

const { mockDispatchReviewNow } = vi.hoisted(() => ({
  mockDispatchReviewNow: vi.fn(),
}));

vi.mock('../../agents/loop/review-dispatcher.js', () => ({
  getReviewDispatcher: () => ({ dispatchReviewNow: mockDispatchReviewNow }),
}));

import router from '../workunit.routes.js';

describe('F6-c 证据断链修复路由（/verify + /dispatch-review）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function post(path: string, init?: { body?: unknown; headers?: Record<string, string> }) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  // ─── POST /:id/verify（#551：kind → HTTP 翻译） ───

  it('verify：agent 身份 → 403，service 未调用', async () => {
    const res = await post('/wu-1/verify', { body: { authorType: 'agent' } });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
    expect(mockVerifyManually).not.toHaveBeenCalled();
  });

  it('verify：not-found → 404 NOT_FOUND', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'not-found' });
    const res = await post('/wu-x/verify');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string; message: string } };
    expect(json.error.code).toBe('NOT_FOUND');
    expect(json.error.message).toBe('WorkUnit wu-x not found');
  });

  it('verify：not-code-type → 400 INVALID_INPUT（message 带 wuType）', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'not-code-type', wuType: 'review' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { code: string; message: string } };
    expect(json.error.code).toBe('INVALID_INPUT');
    expect(json.error.message).toContain('type=review');
  });

  it('verify：no-worktree → 409 NO_WORKTREE', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'no-worktree' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(409);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NO_WORKTREE');
  });

  it('verify：no-commands → 422 { verified:false, reason:no-commands, hint }', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'no-commands' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(422);
    const json = await res.json() as { verified: boolean; reason: string; hint: string };
    expect(json.verified).toBe(false);
    expect(json.reason).toBe('no-commands');
    expect(json.hint).toContain('verifyCommands');
  });

  it('verify：failed → 200 { verified:false, failed:[{command,tail}] }', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'failed', failure: { command: 'make check', tail: 'boom' } });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(200);
    const json = await res.json() as { verified: boolean; failed: Array<{ command: string; tail: string }> };
    expect(json.verified).toBe(false);
    expect(json.failed).toEqual([{ command: 'make check', tail: 'boom' }]);
  });

  it('verify：verified → 200 { verified:true, report }', async () => {
    const report = { commands: ['pnpm run test'], source: 'convention', passedAt: '2026-07-30T00:00:00Z' };
    mockVerifyManually.mockResolvedValue({ kind: 'verified', report });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(200);
    const json = await res.json() as { verified: boolean; report: { commands: string[] } };
    expect(json.verified).toBe(true);
    expect(json.report.commands).toEqual(['pnpm run test']);
  });

  it('verify：body.commands 过滤透传 + by=登录用户名（STUDIO_AUTH=none → Local User）', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'verified', report: {} });
    const res = await post('/wu-1/verify', { body: { commands: ['./ci.sh', '  ', 42] } });
    expect(res.status).toBe(200);
    expect(mockVerifyManually).toHaveBeenCalledWith('wu-1', {
      by: 'Local User',
      commands: ['./ci.sh'],
    });
  });

  it('verify：body.commands 缺省/空数组 → 不传 commands 键（不落覆盖语义）', async () => {
    mockVerifyManually.mockResolvedValue({ kind: 'no-commands' });
    await post('/wu-1/verify');
    expect(mockVerifyManually).toHaveBeenCalledWith('wu-1', { by: 'Local User' });

    mockVerifyManually.mockClear();
    await post('/wu-1/verify', { body: { commands: [] } });
    expect(mockVerifyManually).toHaveBeenCalledWith('wu-1', { by: 'Local User' });
  });

  it('verify：service 抛错 → 500 INTERNAL_ERROR', async () => {
    mockVerifyManually.mockRejectedValue(new Error('disk gone'));
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(500);
    const json = await res.json() as { error: { code: string; message: string } };
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(json.error.message).toBe('disk gone');
  });

  // ─── POST /:id/dispatch-review ───

  it('dispatch-review：agent 身份 → 403，dispatcher 未调用', async () => {
    const res = await post('/wu-1/dispatch-review', { body: { authorType: 'agent' } });
    expect(res.status).toBe(403);
    expect(mockDispatchReviewNow).not.toHaveBeenCalled();
  });

  it('dispatch-review：WU 不存在 → 404', async () => {
    mockDispatchReviewNow.mockRejectedValue(new Error('WorkUnit wu-x not found'));
    const res = await post('/wu-x/dispatch-review');
    expect(res.status).toBe(404);
  });

  it('dispatch-review：type=analysis → 400（analysis 验收闸是人工 L3）', async () => {
    mockDispatchReviewNow.mockRejectedValue(new Error('WorkUnit type analysis is not reviewable (review 不再被评审；analysis 验收闸是人工 L3)'));
    const res = await post('/wu-1/dispatch-review');
    expect(res.status).toBe(400);
  });

  it('dispatch-review：status=active → 400', async () => {
    mockDispatchReviewNow.mockRejectedValue(new Error('Cannot dispatch review: current status is active, expected in_review/done'));
    const res = await post('/wu-1/dispatch-review');
    expect(res.status).toBe(400);
  });

  it('dispatch-review：l2 已达成 → 409；已有未完结评审子 WU → 409', async () => {
    mockDispatchReviewNow.mockRejectedValue(new Error('L2 review evidence already present — 无需补派'));
    expect((await post('/wu-1/dispatch-review')).status).toBe(409);
    mockDispatchReviewNow.mockRejectedValue(new Error('Review child already in flight — 已有未完结的评审子 WU'));
    expect((await post('/wu-1/dispatch-review')).status).toBe(409);
  });

  it('dispatch-review：成功 → 200 { reviewWorkUnitId }', async () => {
    mockDispatchReviewNow.mockResolvedValue({ id: 'child-9' });
    const res = await post('/wu-1/dispatch-review');
    expect(res.status).toBe(200);
    const json = await res.json() as { reviewWorkUnitId: string };
    expect(json.reviewWorkUnitId).toBe('child-9');
    expect(mockDispatchReviewNow).toHaveBeenCalledWith('wu-1');
  });
});
