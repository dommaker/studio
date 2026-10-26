/**
 * Discord interactions 路由测试（#538 从零补齐——现状零覆盖）
 *
 * 钉住 ADR 2026-09-15 决策 2 的收口语义：
 *  - retry / retry-new 按钮 → unclaim 回池 + 重试标记经 updateMetadata 语义口合并
 *    （#554：patch 并入走 WorkUnitService，路由零直摸 FileStore 写原语；
 *    旧实现整写 metadata 覆盖摧毁既有键、直摸 commitSnapshot 绕过 service 层）
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

const { mockFileStore, mockUnclaim, mockUpdateMetadata, mockClose, mockAgentStop, mockEventBusPublish } = vi.hoisted(() => ({
  mockFileStore: {
    getIndex: vi.fn(),
    updateMetadata: vi.fn(),
    commitSnapshot: vi.fn(),
    commitRemoval: vi.fn(),
    getDataDir: vi.fn(() => '/unused'),
    withLock: vi.fn(),
    readJsonUncached: vi.fn(),
    writeJson: vi.fn(),
  },
  mockUnclaim: vi.fn(),
  mockUpdateMetadata: vi.fn(),
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

vi.mock('../../workunit/workunit-review.js', () => ({
  WorkUnitService: vi.fn(function () { return { unclaim: mockUnclaim, close: mockClose, updateMetadata: mockUpdateMetadata }; }),
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
  let replayLedger: unknown = null;

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
    replayLedger = null;
    mockFileStore.withLock.mockImplementation(async (_path, fn) => fn());
    mockFileStore.readJsonUncached.mockImplementation(async () => structuredClone(replayLedger));
    mockFileStore.writeJson.mockImplementation(async (_path, value) => {
      replayLedger = structuredClone(value);
    });
    mockClose.mockResolvedValue(true);
    mockUnclaim.mockResolvedValue({});
    mockUpdateMetadata.mockResolvedValue({});
  });

  async function postInteraction(payload: unknown, opts?: { badSignature?: boolean; timestamp?: string }) {
    const body = JSON.stringify(payload);
    const timestamp = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
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

  const button = (customId: string) => ({ id: `interaction-${customId}`, type: 3, data: { component_type: 2, custom_id: customId } });

  it('签名无效 → 401（签名验证优先于业务逻辑）', async () => {
    const res = await postInteraction(button('abandon:wu-1'), { badSignature: true });
    expect(res.status).toBe(401);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it.each([-301, 301])('签名正确但 timestamp 超出五分钟（offset=%s）→ 401，零业务或台账副作用', async (offset) => {
    const timestamp = String(Math.floor(Date.now() / 1000) + offset);
    const res = await postInteraction(button('retry:wu-expired:3'), { timestamp });
    expect(res.status).toBe(401);
    expect(mockUnclaim).not.toHaveBeenCalled();
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockFileStore.writeJson).not.toHaveBeenCalled();
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
  });

  it('retry 按钮 → unclaim 回池 + updateMetadata 语义口合并（resumeAfterRetry + extraRounds），零直写', async () => {
    const res = await postInteraction(button('retry:wu-1:3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('🔁');
    expect(body.data.content).toContain('3');

    expect(mockUnclaim).toHaveBeenCalledWith('wu-1');
    // #554：重试标记走 service 语义口（patch 并入，锁内合并语义由 service/FileStore 层测试钉住）
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledWith('wu-1', { resumeAfterRetry: true, extraRounds: 3 });
    // 不直摸 FileStore 写原语（含 updateMetadata）
    expect(mockFileStore.updateMetadata).not.toHaveBeenCalled();
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    expect(mockFileStore.commitRemoval).not.toHaveBeenCalled();
  });

  it('同 interaction 重放复用首个响应，不重复业务写或改重放台账', async () => {
    const interaction = button('retry:wu-replay:4');
    const first = await postInteraction(interaction);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const ledgerBefore = structuredClone(replayLedger);

    const replay = await postInteraction(interaction);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(mockUnclaim).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockFileStore.commitSnapshot).not.toHaveBeenCalled();
    expect(mockEventBusPublish).not.toHaveBeenCalled();
    expect(replayLedger).toEqual(ledgerBefore);
  });

  it('慢处理超过旧 60s 租约仍拒绝在途重放，不重复业务副作用', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    let finishFirst!: () => void;
    let calls = 0;
    mockUnclaim.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
      return {};
    });
    const interaction = button('retry:wu-slow:2');
    const firstPromise = postInteraction(interaction);
    while (mockUnclaim.mock.calls.length === 0) await new Promise(r => setTimeout(r, 5));
    now += 61_000;

    let replay: Response;
    try {
      replay = await postInteraction(interaction);
    } finally {
      finishFirst();
      await firstPromise;
      Date.now = realNow;
    }

    expect(replay.status).toBe(409);
    expect(mockUnclaim).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
  });

  it('业务副作用后 complete 失败返回 503 并保留 processing，重试 409 且零重复写', async () => {
    let writes = 0;
    mockFileStore.writeJson.mockImplementation(async (_path, value) => {
      writes += 1;
      if (writes === 2) throw new Error('complete failed');
      replayLedger = structuredClone(value);
    });
    const interaction = button('retry:wu-complete-failed:2');
    const first = await postInteraction(interaction);
    const replay = await postInteraction(interaction);

    expect(first.status).toBe(503);
    expect(replay.status).toBe(409);
    expect(mockUnclaim).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(writes).toBe(2);
  });

  it('业务异常可能部分成功时不释放，同 ID 重试不重复执行', async () => {
    mockUnclaim.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce({});
    const interaction = button('retry:wu-retry-after-failure:2');
    const failed = await postInteraction(interaction);
    expect(failed.status).toBe(200);
    const failedBody = await failed.json();
    expect(failedBody.data.content).toContain('temporary failure');

    const retry = await postInteraction(interaction);

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(failedBody);
    expect(mockUnclaim).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).not.toHaveBeenCalled();
  });

  it('业务写入前的只读失败可释放，同 ID 重试允许继续', async () => {
    const exec = makeSnapshot('exec-read-retry', { status: 'active' });
    mockFileStore.getIndex
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue([exec]);
    const interaction = {
      id: 'interaction-read-retry',
      type: 2,
      data: {
        name: 'studio',
        options: [{ name: 'stop', options: [{ name: 'execution_id', value: exec.id }] }],
      },
    };
    const failed = await postInteraction(interaction);
    expect(failed.status).toBe(200);
    expect((await failed.json()).data.content).toContain('read failed');

    const retry = await postInteraction(interaction);

    expect(retry.status).toBe(200);
    expect((await retry.json()).data.content).toContain('Stopped execution');
    expect(mockFileStore.getIndex).toHaveBeenCalledTimes(3);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockAgentStop).toHaveBeenCalledTimes(1);
  });

  it('retry-new 按钮 → unclaim + updateMetadata 语义口合并（resumeAfterRetry + freshPrompt）', async () => {
    const res = await postInteraction(button('retry-new:wu-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toContain('🔄');

    expect(mockUnclaim).toHaveBeenCalledWith('wu-1');
    expect(mockUpdateMetadata).toHaveBeenCalledWith('wu-1', { resumeAfterRetry: true, freshPrompt: true });
    expect(mockFileStore.updateMetadata).not.toHaveBeenCalled();
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

  it('abandon 目标存在但状态机拒绝（decision/spec 无 closed 边）→ 回真实原因而非 not found（#555）', async () => {
    const snap = makeSnapshot('wu-2', { type: 'decision', status: 'done' });
    mockFileStore.getIndex.mockResolvedValue([snap]);
    mockClose.mockRejectedValue(new Error('Invalid status transition: done → closed'));

    const res = await postInteraction(button('abandon:wu-2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).not.toMatch(/not found/i);
    expect(body.data.content).toContain('Invalid status transition: done → closed');
  });

  it('abandon 目标存在但落库失败 → 回真实原因而非 not found（#555）', async () => {
    const snap = makeSnapshot('wu-3');
    mockFileStore.getIndex.mockResolvedValue([snap]);
    mockClose.mockRejectedValue(new Error('commitSnapshot failed: disk full'));

    const res = await postInteraction(button('abandon:wu-3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).not.toMatch(/not found/i);
    expect(body.data.content).toContain('commitSnapshot failed: disk full');
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
      id: 'interaction-studio-stop',
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
      id: 'interaction-studio-stop',
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
