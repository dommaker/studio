import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockValidate } = vi.hoisted(() => ({ mockValidate: vi.fn() }));
vi.mock('../gate-checker.service.js', () => ({
  gateCheckerService: { validate: mockValidate },
}));

import { specsWriteRoutes } from '../routes.js';

describe('Specs validate HTTP 宿主命令边界', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: 'test-user',
        email: 'test@example.invalid',
        name: 'Test User',
        role: req.header('x-test-role') === 'Admin' ? 'Admin' : 'User',
        companyId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      next();
    });
    app.use('/specs', specsWriteRoutes);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/specs`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('User/Admin/伪造 human 均不能提交命令或 workdir，service 零调用', async () => {
    for (const role of ['User', 'Admin']) {
      for (const body of [
        { checkpoints: ['command_success'], harnessConfigs: [{ type: 'command_success', harness: { command: 'custom-command' } }] },
        { checkpoints: ['output_matches'], harnessConfigs: [{ type: 'output_matches', harness: { pattern: '^ok', command: 'custom-command' } }] },
        { checkpoints: ['file_exists'], harnessConfigs: [{ type: 'file_exists', harness: { path: 'package.json', workdir: '/tmp' } }] },
        { authorType: 'human', checkpoints: ['command_success'], harnessConfigs: [{ type: 'command_success', harness: { command: 'custom-command' } }] },
      ]) {
        const res = await fetch(`${base}/changes/change-1/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-role': role },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }
    }
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('合法非命令检查仍进入 service', async () => {
    mockValidate.mockResolvedValue({
      changeId: 'change-1', level: 'L3', passed: true, checks: [], summary: 'ok', canProceed: true,
    });
    const res = await fetch(`${base}/changes/change-1/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkpoints: ['file_exists'],
        harnessConfigs: [{ type: 'file_exists', harness: { path: 'package.json' } }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockValidate).toHaveBeenCalledTimes(1);
  });
});
