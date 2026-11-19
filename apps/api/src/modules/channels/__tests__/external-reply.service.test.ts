import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { workUnitSchema } from '@dommaker/studio-contract';
import { EffectService, postWuSystemMessage, registerWorkUnitPorts, toWorkUnitWire, WorkUnitService, type WorkUnitData } from '../../workunit/index.js';

const operator = { id: 'operator-1', type: 'Operator' } as const;

let tmpDir: string;
let store: FileStore;
let workUnits: WorkUnitService;
let alerts: Array<{ source: string; level: string; message: string }>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-reply-effect-'));
  store = new FileStore(tmpDir);
  workUnits = new WorkUnitService(store);
  alerts = [];
  registerWorkUnitPorts({ alert: { dispatch: entries => alerts.push(...entries) } });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createWorkUnit(): Promise<WorkUnitData> {
  return workUnits.create({
    scope: '持久外部回复', type: 'task', status: 'active', channelId: 'channel-1',
    authorization: { requestedBy: operator, source: { kind: 'api' } },
  });
}

describe('WU 外部回复 Effect', () => {
  it('提交后执行持久意图，并保存与可观察消息对应的 Receipt', async () => {
    const wu = await createWorkUnit();

    const message = await postWuSystemMessage(wu, '  已完成第一步  ', {
      fileStore: store, agentName: 'developer', replyToId: 'anchor-1', meta: { cardType: 'progress' },
    });

    expect(message).toMatchObject({
      channelId: 'channel-1', workUnitId: wu.id, agentName: 'developer',
      content: '已完成第一步', replyToId: 'anchor-1', meta: { cardType: 'progress' },
    });
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects).toHaveLength(1);
    expect(projection.effects[0]).toMatchObject({
      kind: 'external-reply', status: 'succeeded', attempts: 1,
      payload: {
        messageId: message!.id, channelId: 'channel-1', workUnitId: wu.id,
        agentName: 'developer', content: '已完成第一步', replyToId: 'anchor-1',
      },
    });
    expect(projection.receipts).toHaveLength(1);
    expect(projection.receipts[0]).toMatchObject({
      outcome: 'succeeded', result: { messageId: message!.id },
    });
    const readModel = await workUnits.getById(wu.id);
    expect(workUnitSchema.parse(toWorkUnitWire(readModel!)).effects?.[0]?.kind).toBe('external-reply');
  });

  it('消息落盘后崩溃的重启恢复按稳定 id 认养，不重复产生可观察回复', async () => {
    const wu = await createWorkUnit();
    const originalAppend = store.appendMessage.bind(store);
    store.appendMessage = async (channelId, message) => {
      await originalAppend(channelId, message);
      throw new Error('simulated crash after message append');
    };
    await expect(postWuSystemMessage(wu, '崩溃前已落盘', { fileStore: store })).rejects.toThrow('simulated crash');
    store.appendMessage = originalAppend;

    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30_000);
    const { recoverExternalReplies } = await import('../index.js');
    const recovered = await recoverExternalReplies(store);
    vi.useRealTimers();

    expect(recovered).toMatchObject({ attempted: 1, succeeded: 1 });
    const messages = await store.queryMessages('channel-1', { workUnitId: wu.id });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: '崩溃前已落盘' });
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({
      status: 'succeeded', attempts: 2, payload: { messageId: messages[0].id },
    });
    expect(projection.receipts.map(receipt => receipt.outcome)).toEqual(['retrying', 'succeeded']);
    expect(projection.receipts[1]).toMatchObject({
      recovery: 'queued-restarted',
      result: { messageId: messages[0].id, duplicatePrevented: true },
    });
  });

  it('临时失败到期后自动重试，同一意图成功后停止', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    const wu = await createWorkUnit();
    const originalAppend = store.appendMessage.bind(store);
    let failures = 0;
    store.appendMessage = async (channelId, message) => {
      if (failures++ === 0) throw new Error('temporary append failure');
      await originalAppend(channelId, message);
    };

    await expect(postWuSystemMessage(wu, '到期重试', { fileStore: store })).rejects.toThrow('temporary append failure');
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => {
      const projection = await new EffectService(store).getProjection(wu.id);
      expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    });
    vi.useRealTimers();

    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(1);
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(projection.receipts.map(receipt => receipt.outcome)).toEqual(['retrying', 'succeeded']);
  });

  it('周期恢复遇到同进程正在发送的 Effect 时共用执行，不重复 append/SSE', async () => {
    const wu = await createWorkUnit();
    const originalAppend = store.appendMessage.bind(store);
    let appendCalls = 0;
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    store.appendMessage = async (channelId, message) => {
      appendCalls++;
      markEntered();
      await gate;
      await originalAppend(channelId, message);
    };

    const posting = postWuSystemMessage(wu, '正在发送', { fileStore: store });
    await entered;
    const { recoverExternalReplies } = await import('../index.js');
    const recovering = recoverExternalReplies(store);
    release();
    await Promise.all([posting, recovering]);

    expect(appendCalls).toBe(1);
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(1);
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(projection.receipts).toHaveLength(1);
  });

  it('临时失败最多执行三次，永久失败保留 Receipt 并明确告警', async () => {
    const wu = await createWorkUnit();
    store.appendMessage = async () => { throw new Error('channel temporarily unavailable'); };

    await expect(postWuSystemMessage(wu, '会失败的回复', { fileStore: store })).rejects.toThrow('channel temporarily unavailable');
    expect(alerts).toHaveLength(0);

    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['Date'] });
    const { recoverExternalReplies } = await import('../index.js');
    vi.setSystemTime(Date.now() + 30_000);
    await recoverExternalReplies(store);
    expect(alerts).toHaveLength(0);
    vi.setSystemTime(Date.now() + 30_000);
    await recoverExternalReplies(store);
    vi.useRealTimers();

    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(projection.receipts.map(receipt => receipt.outcome)).toEqual(['retrying', 'retrying', 'failed']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'external_reply_permanent_failure', level: 'critical' });
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(0);

    const finalRecovery = await recoverExternalReplies(store);
    expect(finalRecovery.attempted).toBe(0);
  });

  it('Mandate 撤销取消排队回复，后续恢复不会发送', async () => {
    const wu = await createWorkUnit();
    store.appendMessage = async () => { throw new Error('not sent yet'); };
    await expect(postWuSystemMessage(wu, '排队后撤销', { fileStore: store })).rejects.toThrow('not sent yet');

    await workUnits.revokeMandate(wu.id, operator, '停止回复');
    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30_000);
    const { recoverExternalReplies } = await import('../index.js');
    const recovered = await recoverExternalReplies(store);
    vi.useRealTimers();

    expect(recovered.attempted).toBe(0);
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ kind: 'external-reply', status: 'cancelled', attempts: 1 });
    expect(projection.receipts.at(-1)).toMatchObject({ outcome: 'cancelled', recovery: 'revocation' });
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(0);
  });

  it('撤销时运行中的回复已落盘，恢复只核查并补 Receipt，不重发', async () => {
    const wu = await createWorkUnit();
    const originalAppend = store.appendMessage.bind(store);
    store.appendMessage = async (channelId, message) => {
      await originalAppend(channelId, message);
      throw new Error('crash after append');
    };
    await expect(postWuSystemMessage(wu, '撤销前已发送', { fileStore: store })).rejects.toThrow('crash after append');
    store.appendMessage = originalAppend;

    const current = (await store.getIndex({ id: wu.id }))[0]!;
    const running = {
      ...current,
      effects: current.effects?.map(effect => ({
        ...effect, status: 'running' as const, nextAttemptAt: undefined,
      })),
    };
    await store.commitSnapshot({
      type: 'updated', wuId: wu.id, timestamp: new Date().toISOString(),
      data: running as unknown as Record<string, unknown>,
    }, running);
    await workUnits.revokeMandate(wu.id, operator, '核查运行中回复');

    const { recoverExternalReplies } = await import('../index.js');
    const recovered = await recoverExternalReplies(store);

    expect(recovered).toMatchObject({ attempted: 1, succeeded: 1 });
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(projection.receipts.at(-1)).toMatchObject({
      outcome: 'succeeded', recovery: 'running-reconciled', result: { duplicatePrevented: true },
    });
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(1);
  });

  it('撤销后找不到运行中回复时保留人工核查，绝不补发', async () => {
    const wu = await createWorkUnit();
    store.appendMessage = async () => { throw new Error('unknown whether sent'); };
    await expect(postWuSystemMessage(wu, '结果不确定', { fileStore: store })).rejects.toThrow('unknown whether sent');
    const current = (await store.getIndex({ id: wu.id }))[0]!;
    const running = {
      ...current,
      effects: current.effects?.map(effect => ({
        ...effect, status: 'running' as const, nextAttemptAt: undefined,
      })),
    };
    await store.commitSnapshot({
      type: 'updated', wuId: wu.id, timestamp: new Date().toISOString(),
      data: running as unknown as Record<string, unknown>,
    }, running);
    await workUnits.revokeMandate(wu.id, operator, '不确定结果转人工');

    const { recoverExternalReplies } = await import('../index.js');
    const recovered = await recoverExternalReplies(store);

    expect(recovered).toMatchObject({ attempted: 1, succeeded: 0, failed: 0 });
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects[0]).toMatchObject({ status: 'needs_reconciliation', attempts: 2 });
    expect(await store.queryMessages('channel-1', { workUnitId: wu.id })).toHaveLength(0);
  });
});
