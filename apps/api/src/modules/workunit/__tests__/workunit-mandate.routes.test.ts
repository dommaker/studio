import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockCreate, mockUpdate, mockAuthorize, mockRevoke } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockAuthorize: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock('../workunit-review.js', () => ({
  WorkUnitService: class {
    create = mockCreate;
    update = mockUpdate;
    authorizeMandate = mockAuthorize;
    revokeMandate = mockRevoke;
  },
}));

import { workunitOpenRoutes, workunitWriteRoutes } from '../workunit.routes.js';
import { requireAuth, requireNotGuest } from '../../../middleware/auth.js';
import { validWorkUnit } from './route-fixtures.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/workunits', workunitOpenRoutes, requireAuth(), requireNotGuest(), workunitWriteRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/workunits`;
});

afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(validWorkUnit());
  mockUpdate.mockResolvedValue(validWorkUnit());
  mockAuthorize.mockResolvedValue(validWorkUnit());
  mockRevoke.mockResolvedValue(validWorkUnit());
});

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('Mandate HTTP 主体与写边界', () => {
  it('建单请求人和扩权操作人只取认证 Principal，忽略伪造元数据', async () => {
    const create = await post('/', {
      scope: '伪造身份', requestedBy: { id: 'mallory' }, metadata: { authorType: 'human', agentName: 'mallory' },
    });
    expect(create.status).toBe(201);
    expect(mockCreate.mock.calls[0][0].authorization.requestedBy).toEqual({ id: 'local', type: 'Operator' });

    const expanded = await post('/wu-1/mandate/authorize', {
      requestedBy: { id: 'mallory' }, operator: 'mallory', budget: { tokens: 9000 },
    });
    expect(expanded.status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledWith('wu-1', { id: 'local', type: 'Operator' }, { budget: { tokens: 9000 } });
  });

  it('普通 PUT 不能绕过 Mandate 直改仓库、腿或预算', async () => {
    for (const key of ['workspaceRoot', 'pmoBranch', 'tokenBudget', 'planStepAllowance']) {
      const response = await fetch(`${base}/wu-1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata: { [key]: 1 } }),
      });
      expect(response.status).toBe(400);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('撤销端点只把认证 Principal 和原因交给领域命令', async () => {
    const response = await post('/wu-1/mandate/revoke', { reason: '停止', revokedBy: 'mallory' });
    expect(response.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith('wu-1', { id: 'local', type: 'Operator' }, '停止');
  });
});
