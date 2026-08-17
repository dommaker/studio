// #185（决策 #87 D2）路由契约测试：POST /:id/resume + POST /:id/close（Web 按钮通道）
//  - resume：404 / 409 NOT_BLOCKED 守卫；成功委托 waiting-input 复活原语（纯授权占位文案）
//  - close：404 / 409 NOT_BLOCKED 守卫；decision/spec 无 closed 状态 → 409 NO_CLOSED_STATE
// WorkUnitService / waiting-input 均 mock（router 模块级单例会指向真实 ~/.studio/data），只测路由层契约。
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    getById = mockGetById;
  },
}));

const { mockResumeFromWeb, mockCloseFromWeb } = vi.hoisted(() => ({
  mockResumeFromWeb: vi.fn(),
  mockCloseFromWeb: vi.fn(),
}));

vi.mock('../waiting-input.js', () => ({
  resumeBlockedWorkUnitFromWeb: mockResumeFromWeb,
  closeBlockedWorkUnitFromWeb: mockCloseFromWeb,
}));

import router from '../workunit.routes.js';

const blockedWu = (metadata: Record<string, unknown> = {}) => ({
  id: 'wu-1',
  type: 'task',
  status: 'blocked',
  scope: '实现登录功能',
  metadata: JSON.stringify({ title: '登录功能', ...metadata }),
});

describe('#185（决策 #87 D2）：/resume + /close 路由（Web 按钮通道）', () => {
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

  function post(path: string) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  }

  // ─── POST /:id/resume ───

  it('resume：WU 不存在 → 404，不委托复活原语', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post('/wu-x/resume');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NOT_FOUND');
    expect(mockResumeFromWeb).not.toHaveBeenCalled();
  });

  it('resume：非 blocked（active）→ 409 NOT_BLOCKED，不委托复活原语', async () => {
    mockGetById.mockResolvedValue({ ...blockedWu(), status: 'active' });
    const res = await post('/wu-1/resume');
    expect(res.status).toBe(409);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NOT_BLOCKED');
    expect(mockResumeFromWeb).not.toHaveBeenCalled();
  });

  it('resume：blocked → 委托复活原语（同一原语 = 回复路径共享），200 返回更新后 WU', async () => {
    mockGetById.mockResolvedValue(blockedWu());
    mockResumeFromWeb.mockResolvedValue(true);
    const res = await post('/wu-1/resume');
    expect(res.status).toBe(200);
    expect(mockResumeFromWeb).toHaveBeenCalledWith('wu-1', expect.anything());
    const json = await res.json() as { id: string };
    expect(json.id).toBe('wu-1');
  });

  it('resume：复活原语返回 false（如归属等待型未被纯授权复活）→ 409', async () => {
    mockGetById.mockResolvedValue(blockedWu());
    mockResumeFromWeb.mockResolvedValue(false);
    const res = await post('/wu-1/resume');
    expect(res.status).toBe(409);
  });

  // ─── POST /:id/close ───

  it('close：WU 不存在 → 404，不委托关闭路径', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post('/wu-x/close');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NOT_FOUND');
    expect(mockCloseFromWeb).not.toHaveBeenCalled();
  });

  it('close：非 blocked（done）→ 409 NOT_BLOCKED，不委托关闭路径', async () => {
    mockGetById.mockResolvedValue({ ...blockedWu(), status: 'done' });
    const res = await post('/wu-1/close');
    expect(res.status).toBe(409);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NOT_BLOCKED');
    expect(mockCloseFromWeb).not.toHaveBeenCalled();
  });

  it('close：blocked → 委托死信显式关闭路径，200 返回更新后 WU', async () => {
    mockGetById.mockResolvedValue(blockedWu());
    mockCloseFromWeb.mockResolvedValue('closed');
    const res = await post('/wu-1/close');
    expect(res.status).toBe(200);
    expect(mockCloseFromWeb).toHaveBeenCalledWith('wu-1', expect.anything());
    const json = await res.json() as { id: string };
    expect(json.id).toBe('wu-1');
  });

  it('close：decision/spec 裁剪状态机无 closed → 409 NO_CLOSED_STATE', async () => {
    mockGetById.mockResolvedValue({ ...blockedWu(), type: 'decision' });
    mockCloseFromWeb.mockResolvedValue('rejected-no-closed-state');
    const res = await post('/wu-1/close');
    expect(res.status).toBe(409);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('NO_CLOSED_STATE');
  });
});
