/**
 * Discord interactions 路由测试（#538 从零补齐——现状零覆盖）
 *
 * 钉住 ADR 2026-09-15 决策 2 的收口语义：
 *  - retry / retry-new 按钮 → unclaim 回池 + 重试标记经 updateMetadata 锁内合并
 *    （旧实现整写 metadata 覆盖摧毁既有键、直摸 commitSnapshot 绕过 service 层）
 *  - abandon 按钮 / /studio stop → WorkUnitService.close 状态机单口（#550）
 *    （closedBy: human-command，补 closedAt + status_changed + workunit:closed 记录 + 频道出声）
 *  - 停发 legacy events:goal-execution 事件（Goal 体系已退役）
 *
 * 签名验证走真 Ed25519（测试内生成密钥对），路由层契约同 trigger-fire.routes.test.ts 模式：
 * 真 express server + fetch；FileStore / WorkUnitService / agentRunner mock。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';

const { mockFileStore, mockUnclaim, mockClose, mockAgentStop, mockEventBusPublish } = vi.hoisted(() => ({
  mockFileStore: {
    getIndex: vi.fn(),
    updateMetadata: vi.fn(),
    commitSnapshot: vi.fn(),
    commitRemoval: vi.fn(),
  },
  mockUnclaim: vi.fn(),
  mockClose: vi.fn(),
  mockAgentStop: vi.fn(),
  mockEventBusPublish: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    FileStore: vi.fn(function () { return mockFileStore; }),
    eventBus: { publish: mockEventBusPublish, subscribe: vi.fn(), unsubscribe: vi.fn() },
  };
});

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn(function () { return { unclaim: mockUnclaim, close: mockClose }; }),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: mockAgentStop },
}));

import router from '../routes.js';

// 真 Ed25519 密钥对：公钥导出 raw 32 字节（spki der 尾 32B），与路由的 verifyDiscordSignature 同口径
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('hex');

function signBody(body: string, timestamp: string): string {
  return sign(null, Buffer.from(timestamp + body, 'utf-8'), privateKey).toString('hex');
}

function makeSnapshot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    parentId: null,
    type: 'task',
    scope: `scope-${id}`,
    assigneeId: 'agent-1',
    status: 'active',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: 'ch-1',
    projectPath: null,
    metadata: '{"keep":"me"}',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('discord interactions 路由（#538 写路径收口）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY_HEX;
    const app = express();
    app.use(express.raw({ type: () => true }));
    app.use('/discord', router);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/discord`;
  });

  afterAll(async () => {
    delete process.env.DISCORD_PUBLIC_KEY;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClose.mockResolvedValue(true);
    mockUnclaim.mockResolvedValue({});
    mockFileStore.updateMetadata.mockResolvedValue(true);
  });

  async function postInteraction(payload: unknown, opts?: { badSignature?: boolean }) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = opts?.badSignature ? 'deadbeef' : signBody(body, timestamp);
    return fetch(`${base}/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-ed25519': signature,
        'x-signature-timestamp': timestamp,
      },
      body,
    });
  }

  const button = (customId: string) => ({ type: 3, data: { component_type: 2, custom_id: customId } });

  it('签名无效 → 401（签名验证优先于业务逻辑）', async () => {
    const res = await postInteraction(button('abandon:wu-1'), { badSignature: true });
    expect(res.status).toBe(401);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('retry 按钮 → unclaim 回池 + updateMetadata 合并（resumeAfterRetry + extraRounds），零直写', async () => {
    const res = await postInteraction(button('retry:wu-1:3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('🔁');
    expect(body.data.content).toContain('3');

    expect(mockUnclaim).toHaveBeenCalledWith('wu-1');
    expect(mockFileStore.updateMetadata).toHaveBeenCalledTimes(1);
    const [wuId, mutator] = mockFileStore.updateMetadata.mock.calls[0];
    expect(wuId).toBe('wu-1');
    // 合并语义：既有键保留，重试标记并入（旧实现整写覆盖会摧毁 keep 键）
    expect(mutator({ keep: 'me' })).toEqual({ keep: 'me', resumeAfterRetry: true, extraRounds: 3 });
    // 不直摸 FileStore 写原语
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    expect(mockFileStore.commitRemoval).not.toHaveBeenCalled();
  });

  it('retry-new 按钮 → unclaim + updateMetadata 合并（resumeAfterRetry + freshPrompt）', async () => {
    const res = await postInteraction(button('retry-new:wu-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('🔄');

    expect(mockUnclaim).toHaveBeenCalledWith('wu-1');
    const mutator = mockFileStore.updateMetadata.mock.calls[0][1];
    expect(mutator({ keep: 'me' })).toEqual({ keep: 'me', resumeAfterRetry: true, freshPrompt: true });
  });

  it('abandon 按钮 → WorkUnitService.close 状态机单口（human-command），不直写不发 legacy 事件', async () => {
    const snap = makeSnapshot('wu-1');
    mockFileStore.getIndex.mockResolvedValue([snap]);

    const res = await postInteraction(button('abandon:wu-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('已放弃');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith('wu-1', { reason: 'Abandoned by user via Discord', closedBy: 'human-command' });
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    // legacy events:goal-execution 停发（Goal 体系已退役）
    expect(mockEventBusPublish).not.toHaveBeenCalledWith('events:goal-execution', expect.anything());
  });

  it('abandon 目标不存在 → 不关闭，回 not found', async () => {
    mockFileStore.getIndex.mockResolvedValue([]);

    const res = await postInteraction(button('abandon:wu-404'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toMatch(/not found/i);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('/studio stop → WorkUnitService.close 状态机单口 + agentRunner.stop，停发 legacy 事件', async () => {
    const exec = makeSnapshot('exec-abc123', { status: 'active' });
    mockFileStore.getIndex.mockResolvedValue([exec]);

    const res = await postInteraction({
      type: 2,
      data: {
        name: 'studio',
        options: [{ name: 'stop', options: [{ name: 'execution_id', value: 'exec-abc123' }] }],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('✅ Stopped');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith('exec-abc123', { reason: 'Stopped by user via Discord', closedBy: 'human-command' });
    expect(mockAgentStop).toHaveBeenCalledWith('exec-abc123');
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    expect(mockEventBusPublish).not.toHaveBeenCalledWith('events:goal-execution', expect.anything());
  });

  it('/studio stop 终态 WU → 拒绝且不关闭', async () => {
    const exec = makeSnapshot('exec-done', { status: 'done' });
    mockFileStore.getIndex.mockResolvedValue([exec]);

    const res = await postInteraction({
      type: 2,
      data: {
        name: 'studio',
        options: [{ name: 'stop', options: [{ name: 'execution_id', value: 'exec-done' }] }],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('Cannot stop');
    expect(mockClose).not.toHaveBeenCalled();
  });
});
