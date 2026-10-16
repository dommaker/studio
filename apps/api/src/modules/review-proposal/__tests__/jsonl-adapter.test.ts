/**
 * review-proposal/jsonl-adapter — JSONL 存储路径 adapter 工厂测试（P2.2）
 *
 * 收拢面：register(deps?) 缺省解析（getStore()/studioDir()）与物化路径
 * <dataDir>/<storeNamespace>.jsonl、get() 自助注册兜底、submit() 补 id/createdAt
 * 走正本生命周期（发卡失败落 card-failed 墓碑）、onApprove ctx.fileStore =
 * 注册时解析的实例（auditor 建工单语义）。卡片渲染与 approve/reject 语义归业务
 * 方 config，不在本工厂重复验证（三家接入点由各自模块 review-adapter 测试兜底）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../../core/store.js';

const { mockCreateCardMessage } = vi.hoisted(() => ({ mockCreateCardMessage: vi.fn() }));

vi.mock('../../channels/channel-message.service.js', () => ({
  getChannelMessageService: () => ({ createCardMessage: mockCreateCardMessage }),
}));

import { createJsonlReviewAdapter, type JsonlReviewAdapterConfig } from '../jsonl-adapter.js';
import { getReviewProposalAdapter, clearReviewProposalAdapters } from '../registry.js';

interface TestProposal {
  id: string;
  createdAt: string;
  payload: string;
}

function makeKit(overrides?: Partial<JsonlReviewAdapterConfig<TestProposal>>) {
  return createJsonlReviewAdapter<TestProposal>({
    kind: 'test',
    cardType: 'test_proposal',
    storeNamespace: 'test-proposals',
    renderCardContent: p => ({ content: `提案 ${p.id}`, cardData: { proposalId: p.id } }),
    onApprove: async () => ({ status: 'executed' }),
    ...overrides,
  });
}

let tmpDir: string;
let fileStore: FileStore;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-jsonl-adapter-'));
  fileStore = new FileStore(tmpDir);
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
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

describe('createJsonlReviewAdapter register', () => {
  it('deps 给定时按 deps 注册：物化 <dataDir>/<storeNamespace>.jsonl，config 差异面透传', async () => {
    const kit = makeKit({ author: 'Auditor' });
    const adapter = kit.register({ fileStore, dataDir: tmpDir });
    expect(getReviewProposalAdapter('test')).toBe(adapter);
    expect(adapter.kind).toBe('test');
    expect(adapter.cardType).toBe('test_proposal');
    expect(adapter.author).toBe('Auditor');
    expect(adapter.fileStore).toBe(fileStore);
    await adapter.store.appendProposal({ id: 'p-1', createdAt: new Date().toISOString(), payload: 'x' });
    expect(fs.existsSync(path.join(tmpDir, 'test-proposals.jsonl'))).toBe(true);
  });

  it('deps 缺省 → fileStore=getStore() / dataDir=studioDir()（register 时解析）', () => {
    const adapter = makeKit().register();
    expect(adapter.fileStore).toBe(getStore());
    expect(adapter.dataDir).toBe(studioDir());
  });

  it('同 kind 重复 register 后者生效（幂等，运行时装配口径不变）', () => {
    const kit = makeKit();
    const first = kit.register({ fileStore, dataDir: tmpDir });
    const second = kit.register({ fileStore, dataDir: tmpDir });
    expect(getReviewProposalAdapter('test')).toBe(second);
    expect(getReviewProposalAdapter('test')).not.toBe(first);
  });
});

describe('createJsonlReviewAdapter get', () => {
  it('未注册 → 自助注册（幂等）；已注册 → 原样返回', () => {
    const kit = makeKit();
    const auto = kit.get();
    expect(getReviewProposalAdapter('test')).toBe(auto);
    expect(kit.get()).toBe(auto);
  });
});

describe('createJsonlReviewAdapter submit', () => {
  it('补 id/createdAt 走正本生命周期：发卡成功 → pending；渲染进卡', async () => {
    await seedSystemChannel();
    const kit = makeKit();
    kit.register({ fileStore, dataDir: tmpDir });
    const result = await kit.submit({ payload: 'hello' });
    expect(result.posted).toBe(true);
    expect(result.proposalId).toBeTruthy();
    const proposal = await getReviewProposalAdapter<TestProposal>('test')!.store.getProposal(result.proposalId);
    expect(proposal).toMatchObject({ id: result.proposalId, payload: 'hello', status: 'pending' });
    expect(proposal!.createdAt).toBeTruthy();
    const [, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(cardType).toBe('test_proposal');
    expect(content).toBe(`提案 ${result.proposalId}`);
    expect(cardData).toEqual({ proposalId: result.proposalId });
  });

  it('发卡失败（频道缺失）→ posted=false + card-failed 墓碑（#101/#143 降级口径）', async () => {
    const kit = makeKit();
    kit.register({ fileStore, dataDir: tmpDir });
    const result = await kit.submit({ payload: 'hello' });
    expect(result.posted).toBe(false);
    const proposal = await getReviewProposalAdapter<TestProposal>('test')!.store.getProposal(result.proposalId);
    expect(proposal!.status).toBe('card-failed');
  });

  it('deps 给定时先按 deps 注册再提交（auditor submit 注入语义）', async () => {
    const kit = makeKit();
    const result = await kit.submit({ payload: 'hello' }, { fileStore, dataDir: tmpDir });
    expect(result.posted).toBe(false); // 测试 fileStore 无 #系统 频道
    expect(getReviewProposalAdapter<TestProposal>('test')!.fileStore).toBe(fileStore);
    expect(fs.existsSync(path.join(tmpDir, 'test-proposals.jsonl'))).toBe(true);
  });

  it('未注册且不给 deps → get() 自助注册后提交（自助注册兜底口径）', async () => {
    const kit = makeKit();
    const result = await kit.submit({ payload: 'hello' });
    expect(result.proposalId).toBeTruthy();
    expect(getReviewProposalAdapter('test')).toBeDefined();
  });
});

describe('createJsonlReviewAdapter onApprove ctx', () => {
  it('ctx.fileStore = 本次 register 解析出的实例（闭包跟注册走，不模块级捕获）', async () => {
    const onApprove = vi.fn(async () => ({ status: 'executed' as const }));
    const kit = makeKit({ onApprove });
    const adapter = kit.register({ fileStore, dataDir: tmpDir });
    await adapter.onApprove({ id: 'p-1', createdAt: new Date().toISOString(), payload: 'x', status: 'pending' });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0][1]).toEqual({ fileStore });
  });
});
