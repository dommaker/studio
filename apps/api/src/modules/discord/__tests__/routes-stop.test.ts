// discord 路由 /studio stop 测试 — 停止执行必须委托 agentRunner.stop
// （旧代码调 agentExecutor.stop，其 runningProcesses 为空 map，静默 no-op）。
// 风格同 outbound-notify/__tests__/routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockAgentRunnerStop, mockGetIndex } = vi.hoisted(() => ({
  mockAgentRunnerStop: vi.fn(),
  mockGetIndex: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: mockAgentRunnerStop },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  class MockFileStore {
    getIndex = mockGetIndex;
    appendEvent = vi.fn().mockResolvedValue(undefined);
    upsertSnapshot = vi.fn().mockResolvedValue(undefined);
    // #170：close/update 走锁内成对原语
    commitSnapshot = vi.fn().mockResolvedValue(undefined);
  }
  return { ...orig, FileStore: MockFileStore };
});

vi.mock('../../../daemon/studio-daemon.js', () => ({
  daemon: { getStatus: () => [], stop: vi.fn(), start: vi.fn() },
}));

// 真实 Ed25519 密钥对 — 路由强制校验签名，必须真实签名
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
process.env.DISCORD_PUBLIC_KEY = publicKeyHex;

import discordRoutes from '../routes.js';

let server: Server;
let base: string;

function signedPost(path: string, body: unknown) {
  const bodyStr = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = crypto.sign(null, Buffer.from(timestamp + bodyStr), privateKey).toString('hex');
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: bodyStr,
  });
}

function stopCommand(executionId: string) {
  return {
    type: 2, // APPLICATION_COMMAND
    data: {
      name: 'studio',
      options: [{ name: 'stop', options: [{ name: 'execution_id', value: executionId }] }],
    },
  };
}

const activeSnapshot = {
  id: 'exec-abc12345',
  status: 'active',
  parentId: 'goal-xyz',
  createdAt: new Date().toISOString(),
  metadata: '{}',
};

beforeAll(async () => {
  mockAgentRunnerStop.mockResolvedValue(undefined);
  const app = express();
  // 与 app.ts 一致：interactions 端点需要 raw body 做签名校验
  app.use('/api/v1/discord/interactions', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use('/api/v1/discord', discordRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('discord /studio stop', () => {
  it('停止 active 执行时委托 agentRunner.stop（精确匹配分支）', async () => {
    mockGetIndex.mockResolvedValue([activeSnapshot]);

    const res = await signedPost('/api/v1/discord/interactions', stopCommand('exec-abc12345'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.content).toContain('Stopped execution');
    expect(mockAgentRunnerStop).toHaveBeenCalledWith('exec-abc12345');
  });

  it('停止 active 执行时委托 agentRunner.stop（前缀匹配分支）', async () => {
    mockAgentRunnerStop.mockClear();
    mockGetIndex.mockResolvedValue([activeSnapshot]);

    const res = await signedPost('/api/v1/discord/interactions', stopCommand('exec-abc'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.content).toContain('Stopped execution');
    expect(mockAgentRunnerStop).toHaveBeenCalledWith('exec-abc12345');
  });

  it('执行不存在时不调用 agentRunner.stop', async () => {
    mockAgentRunnerStop.mockClear();
    mockGetIndex.mockResolvedValue([]);

    const res = await signedPost('/api/v1/discord/interactions', stopCommand('no-such-exec'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.content).toContain('Execution not found');
    expect(mockAgentRunnerStop).not.toHaveBeenCalled();
  });

  it('非 active 状态的执行不调用 agentRunner.stop', async () => {
    mockAgentRunnerStop.mockClear();
    mockGetIndex.mockResolvedValue([{ ...activeSnapshot, status: 'closed' }]);

    const res = await signedPost('/api/v1/discord/interactions', stopCommand('exec-abc12345'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.content).toContain('Cannot stop execution');
    expect(mockAgentRunnerStop).not.toHaveBeenCalled();
  });
});
