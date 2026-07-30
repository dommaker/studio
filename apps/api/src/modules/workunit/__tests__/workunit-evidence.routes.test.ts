// F6-c 证据断链修复路由契约测试：
//  - POST /:id/verify（断点 2）：human-only；404/400/409/422 守卫；全绿落 l1 approved + verifyReport，
//    失败落 l1 rejected；只动台账不动状态；by=登录用户名（STUDIO_AUTH=none → Local User）
//  - POST /:id/dispatch-review（断点 3）：human-only；404/400/409 守卫；成功返回 { reviewWorkUnitId }
// WorkUnitService / wu-verification / review-dispatcher 均 mock（router 模块级单例会指向真实 ~/.studio/data），只测路由层契约。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById, mockRecordL1 } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockRecordL1: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
    recordL1Verification = mockRecordL1;
  },
}));

const { mockResolveVerifyCommands, mockRunWuVerification } = vi.hoisted(() => ({
  mockResolveVerifyCommands: vi.fn(),
  mockRunWuVerification: vi.fn(),
}));

vi.mock('../../agents/wu-verification.js', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  resolveVerifyCommands: mockResolveVerifyCommands,
  runWuVerification: mockRunWuVerification,
}));

const { mockDispatchReviewNow } = vi.hoisted(() => ({
  mockDispatchReviewNow: vi.fn(),
}));

vi.mock('../../agents/review-dispatcher.js', () => ({
  getReviewDispatcher: () => ({ dispatchReviewNow: mockDispatchReviewNow }),
}));

import router from '../workunit.routes.js';

const codeWu = (metadata: Record<string, unknown> = {}) => ({
  id: 'wu-1',
  type: 'task',
  status: 'in_review',
  metadata: JSON.stringify({ worktreePath: '/tmp/wt-1', ...metadata }),
});

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

  // ─── POST /:id/verify ───

  it('verify：agent 身份 → 403，service/验证均未调用', async () => {
    const res = await post('/wu-1/verify', { body: { authorType: 'agent' } });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockRunWuVerification).not.toHaveBeenCalled();
  });

  it('verify：WU 不存在 → 404', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post('/wu-x/verify');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NOT_FOUND');
  });

  it('verify：非代码类 WU（review）→ 400', async () => {
    mockGetById.mockResolvedValue({ ...codeWu(), type: 'review' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { code: string; message: string } };
    expect(json.error.code).toBe('INVALID_INPUT');
    expect(mockRunWuVerification).not.toHaveBeenCalled();
  });

  it('verify：无 worktree 落档 → 409', async () => {
    mockGetById.mockResolvedValue({ id: 'wu-1', type: 'task', status: 'in_review', metadata: '{}' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(409);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NO_WORKTREE');
    expect(mockRunWuVerification).not.toHaveBeenCalled();
  });

  it('verify：无可跑命令 → 422 { verified:false, reason:no-commands, hint }', async () => {
    mockGetById.mockResolvedValue(codeWu());
    mockResolveVerifyCommands.mockResolvedValue({ commands: [], source: 'convention' });
    const res = await post('/wu-1/verify');
    expect(res.status).toBe(422);
    const json = await res.json() as { verified: boolean; reason: string; hint: string };
    expect(json.verified).toBe(false);
    expect(json.reason).toBe('no-commands');
    expect(json.hint).toContain('verifyCommands');
    expect(mockRunWuVerification).not.toHaveBeenCalled();
    expect(mockRecordL1).not.toHaveBeenCalled();
  });

  it('verify：全绿 → 200 { verified:true, report }，落 l1 approved（by=登录用户名，kind=verify）', async () => {
    mockGetById.mockResolvedValue(codeWu());
    mockResolveVerifyCommands.mockResolvedValue({ commands: ['pnpm run test'], source: 'convention' });
    mockRunWuVerification.mockResolvedValue({ ran: ['pnpm run test'], source: 'convention' });
    const verifyReport = { commands: ['pnpm run test'], source: 'convention', passedAt: '2026-07-30T00:00:00Z' };
    mockRecordL1.mockResolvedValue({ id: 'wu-1', metadata: JSON.stringify({ verifyReport }) });

    const res = await post('/wu-1/verify');
    expect(res.status).toBe(200);
    const json = await res.json() as { verified: boolean; report: { commands: string[] } };
    expect(json.verified).toBe(true);
    expect(json.report.commands).toEqual(['pnpm run test']);
    expect(mockRecordL1).toHaveBeenCalledWith('wu-1', {
      by: 'Local User', // STUDIO_AUTH=none 本地模式回落
      ran: ['pnpm run test'],
      source: 'convention',
      failure: undefined,
    });
  });

  it('verify：有失败 → 200 { verified:false, failed:[{command,tail}] }，落 l1 rejected', async () => {
    mockGetById.mockResolvedValue(codeWu());
    mockResolveVerifyCommands.mockResolvedValue({ commands: ['make check'], source: 'override' });
    mockRunWuVerification.mockResolvedValue({
      ran: [],
      source: 'override',
      failure: { command: 'make check', tail: 'boom' },
    });
    mockRecordL1.mockResolvedValue({ id: 'wu-1', metadata: '{}' });

    const res = await post('/wu-1/verify');
    expect(res.status).toBe(200);
    const json = await res.json() as { verified: boolean; failed: Array<{ command: string; tail: string }> };
    expect(json.verified).toBe(false);
    expect(json.failed).toEqual([{ command: 'make check', tail: 'boom' }]);
    expect(mockRecordL1).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      failure: { command: 'make check', tail: 'boom' },
    }));
  });

  it('verify：body.commands 传入时视为 metadata.verifyCommands 覆盖', async () => {
    mockGetById.mockResolvedValue(codeWu({ verifyCommands: ['old cmd'] }));
    mockResolveVerifyCommands.mockResolvedValue({ commands: ['./ci.sh'], source: 'override' });
    mockRunWuVerification.mockResolvedValue({ ran: ['./ci.sh'], source: 'override' });
    mockRecordL1.mockResolvedValue({ id: 'wu-1', metadata: '{}' });

    const res = await post('/wu-1/verify', { body: { commands: ['./ci.sh'] } });
    expect(res.status).toBe(200);
    expect(mockRunWuVerification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wu-1' }),
      expect.objectContaining({ verifyCommands: ['./ci.sh'] }),
      '/tmp/wt-1',
    );
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
