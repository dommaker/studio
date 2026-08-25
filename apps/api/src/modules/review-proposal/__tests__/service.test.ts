/**
 * review-proposal/service (#351) — 提案生命周期行为级测试（以 distill 现有表现为基准）
 *
 * 全链路：建提案 → 发卡 → approve → executed 墓碑；降级与闸口：
 *   - submit：发卡失败 → card-failed 墓碑（不阻塞后续提案）
 *   - approve：not-found / not-pending 闸；executed/failed 落墓碑；skipped 保持 pending（预算熔断口径）
 *   - reject：落 rejected 墓碑 + onReject 回调；零副作用语义归 adapter
 *   - status：查无 → unknown
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockCreateCardMessage } = vi.hoisted(() => ({ mockCreateCardMessage: vi.fn() }));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

import {
  registerReviewProposalAdapter,
  getReviewProposalAdapter,
  clearReviewProposalAdapters,
  type ReviewProposalAdapterConfig,
} from '../registry.js';
import { submitProposal, approveProposal, rejectProposal, getProposalStatus } from '../service.js';

interface TestProposal {
  id: string;
  createdAt: string;
  payload: string;
}

let tmpDir: string;
let fileStore: FileStore;
let onApprove: ReturnType<typeof vi.fn>;
let onReject: ReturnType<typeof vi.fn>;

function makeProposal(id: string): TestProposal {
  return { id, createdAt: new Date().toISOString(), payload: `payload-${id}` };
}

function adapter() {
  return getReviewProposalAdapter<TestProposal>('test')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-service-'));
  fileStore = new FileStore(tmpDir);
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
  onApprove = vi.fn(async () => ({ status: 'executed' as const, data: { productIds: ['x'] } }));
  onReject = vi.fn(async () => {});
  const config: ReviewProposalAdapterConfig<TestProposal> = {
    kind: 'test',
    cardType: 'test_proposal',
    storeNamespace: 'proposals',
    dataDir: tmpDir,
    fileStore,
    renderCardContent: p => ({ content: `提案 ${p.id}`, cardData: { proposalId: p.id, payload: p.payload } }),
    onApprove,
    onReject,
  };
  registerReviewProposalAdapter(config);
});

afterEach(() => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSystemChannel(): Promise<void> {
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-system', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
}

describe('submitProposal（建提案 → 发卡）', () => {
  it('发卡成功：提案 pending + renderCardContent 产出进卡', async () => {
    await seedSystemChannel();
    const result = await submitProposal(adapter(), makeProposal('p-1'));
    expect(result.posted).toBe(true);
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('pending');
    const [, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(cardType).toBe('test_proposal');
    expect(content).toBe('提案 p-1');
    expect(cardData).toEqual({ proposalId: 'p-1', payload: 'payload-p-1' });
  });

  it('发卡失败（频道缺失）→ card-failed 墓碑，posted=false', async () => {
    const result = await submitProposal(adapter(), makeProposal('p-1'));
    expect(result.posted).toBe(false);
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('card-failed');
  });
});

describe('approveProposal（人审 approve）', () => {
  it('全链路：建提案 → 发卡 → approve → executed 墓碑 + onApprove data 返回', async () => {
    await seedSystemChannel();
    await submitProposal(adapter(), makeProposal('p-1'));
    const result = await approveProposal('test', 'p-1');
    expect(result).toEqual({ kind: 'executed', data: { productIds: ['x'] } });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('executed');
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0][0].id).toBe('p-1');
    expect(onApprove.mock.calls[0][0].status).toBe('pending'); // 回调拿到的是审批前记录
  });

  it('onApprove 返回 failed → 落 failed 墓碑', async () => {
    onApprove.mockResolvedValue({ status: 'failed', error: 'provider timeout' });
    await adapter().store.appendProposal(makeProposal('p-1'));
    const result = await approveProposal('test', 'p-1');
    expect(result).toEqual({ kind: 'failed', error: 'provider timeout' });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('failed');
  });

  it('onApprove 返回 skipped（预算熔断）→ 不落墓碑，提案保持 pending 可重试', async () => {
    onApprove.mockResolvedValue({ status: 'pending', skipped: 'budget-exhausted' });
    await adapter().store.appendProposal(makeProposal('p-1'));
    const result = await approveProposal('test', 'p-1');
    expect(result).toEqual({ kind: 'skipped', skipped: 'budget-exhausted' });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('pending');
  });

  it('onApprove 返回 aborted（前置条件不可用）→ 不落墓碑，提案保持 pending', async () => {
    onApprove.mockResolvedValue({ status: 'aborted', error: 'constraints-file-unavailable' });
    await adapter().store.appendProposal(makeProposal('p-1'));
    const result = await approveProposal('test', 'p-1');
    expect(result).toEqual({ kind: 'aborted', error: 'constraints-file-unavailable' });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('pending');
  });

  it('查无提案 → invalid proposal-not-found（onApprove 不调用）', async () => {
    const result = await approveProposal('test', 'nope');
    expect(result).toEqual({ kind: 'invalid', error: 'proposal-not-found' });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('非 pending 提案 → invalid proposal-not-pending:<status>（重复审批拒绝）', async () => {
    await adapter().store.appendProposal(makeProposal('p-1'));
    await approveProposal('test', 'p-1');
    const result = await approveProposal('test', 'p-1');
    expect(result).toEqual({ kind: 'invalid', error: 'proposal-not-pending:executed' });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('未注册 kind → invalid unknown-kind', async () => {
    const result = await approveProposal('ghost', 'p-1');
    expect(result).toEqual({ kind: 'invalid', error: 'unknown-kind:ghost' });
  });
});

describe('rejectProposal（人审 reject）', () => {
  it('reject → rejected 墓碑 + onReject 回调', async () => {
    await adapter().store.appendProposal(makeProposal('p-1'));
    const result = await rejectProposal('test', 'p-1');
    expect(result).toEqual({ ok: true });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('rejected');
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][0].id).toBe('p-1');
  });

  it('onReject 可选缺省 → reject 仍成立', async () => {
    clearReviewProposalAdapters();
    registerReviewProposalAdapter({
      kind: 'test',
      cardType: 'test_proposal',
      storeNamespace: 'proposals',
      dataDir: tmpDir,
      fileStore,
      renderCardContent: p => ({ content: 'x', cardData: {} }),
      onApprove,
    });
    await adapter().store.appendProposal(makeProposal('p-1'));
    expect(await rejectProposal('test', 'p-1')).toEqual({ ok: true });
    expect((await adapter().store.getProposal('p-1'))!.status).toBe('rejected');
  });

  it('查无 / 非 pending / 未知 kind → 拒绝', async () => {
    expect(await rejectProposal('test', 'nope')).toEqual({ ok: false, error: 'proposal-not-found' });
    await adapter().store.appendProposal(makeProposal('p-1'));
    await rejectProposal('test', 'p-1');
    expect(await rejectProposal('test', 'p-1')).toEqual({ ok: false, error: 'proposal-not-pending:rejected' });
    expect(await rejectProposal('ghost', 'p-1')).toEqual({ ok: false, error: 'unknown-kind:ghost' });
  });
});

describe('getProposalStatus（卡片刷新派生已审态）', () => {
  it('存在 → 当前状态；查无 → unknown；未知 kind → unknown-kind 错误', async () => {
    await adapter().store.appendProposal(makeProposal('p-1'));
    expect(await getProposalStatus('test', 'p-1')).toEqual({ ok: true, status: 'pending' });
    expect(await getProposalStatus('test', 'nope')).toEqual({ ok: true, status: 'unknown' });
    expect(await getProposalStatus('ghost', 'p-1')).toEqual({ ok: false, error: 'unknown-kind:ghost' });
  });
});
