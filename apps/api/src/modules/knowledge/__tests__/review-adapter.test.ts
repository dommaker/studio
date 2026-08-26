/**
 * review-adapter (#355) — knowledge 提案审批接线 review-proposal 正本的行为级测试
 *
 * 契约（ADR 2026-08-25 决策 2/4）：
 *   - 提案存取/发卡/approve/reject/status 全归 review-proposal 正本（kind='knowledge'）；
 *     存储物化 <dataDir>/knowledge-proposals.jsonl（append-only），词表 pending|executed|rejected|failed|card-failed。
 *   - 业务方只保留「卡片内容」（knowledge_proposal 聚合卡文案原样保留，cardData 在旧形状
 *     { entries, workUnitId, source } 上增 proposalId 供通用端点审批）与「审批后动作」
 *     （onApprove → knowledgeService.promote 逐条目 draft→verified；onReject → demote 逐条目 draft→archived）。
 *   - 发卡失败落 card-failed 墓碑不抛（#101/#143 降级口径，提取链路不被通知阻断）。
 *
 * 新旧覆盖对照（删旧测前的映射，过 no_test_simplification 闸）：
 *   - knowledge-service-extract-conversation.test「入库成功 → 聚合发卡 / 频道缺失静默跳过 /
 *     无入库条目不发卡」→ 同文件改为经正本链路断言（保留）+ 本文件「submit 发卡 / card-failed」用例
 *   - 旧 postKnowledgeProposalCard 无专属单测（由 extract-conversation 测试覆盖），随实现删除
 *   - approve→promote / reject→demote 副作用断言（原前端逐条目调 /promote|/demote 端点的行为）
 *     → 本文件「正本生命周期全链路」用例
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCreateCardMessage, mockPromote, mockDemote } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn().mockResolvedValue({}),
  mockPromote: vi.fn().mockResolvedValue(undefined),
  mockDemote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

// onApprove/onReject 经动态 import 取 knowledgeService 单例——mock 掉以隔离真实知识库
vi.mock('../knowledge-service.js', () => ({
  knowledgeService: { promote: mockPromote, demote: mockDemote },
}));

import { FileStore } from '@dommaker/studio-shared';
import { clearReviewProposalAdapters } from '../../review-proposal/registry.js';
import { approveProposal, rejectProposal, getProposalStatus } from '../../review-proposal/service.js';
import { registerKnowledgeReviewAdapter, submitKnowledgeProposal } from '../review-adapter.js';

const ENTRIES = [
  { id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' },
  { id: 'k-2', title: '登录流程统一走 auth-service', type: 'guideline' },
];

let tmpRoot: string;
let dataDir: string;
let fileStore: FileStore;
let listChannelsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearReviewProposalAdapters();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-review-adapter-'));
  dataDir = path.join(tmpRoot, 'data');
  fileStore = new FileStore();
  // 发卡频道解析走 adapter.fileStore.listChannels——spy 控制 #系统 频道有无，其余 FileStore I/O 全真
  listChannelsSpy = vi.spyOn(fileStore, 'listChannels').mockResolvedValue([]);
  registerKnowledgeReviewAdapter({ fileStore, dataDir });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('submitKnowledgeProposal — 建提案 + 发卡（行为同旧 knowledge_proposal 聚合卡）', () => {
  it('提案落 pending + 聚合一张卡：文案/cardType 不变，cardData = 旧形状 + proposalId', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);

    const { proposalId, posted } = await submitKnowledgeProposal(ENTRIES, {
      workUnitId: 'wu-1', source: 'conversation:wu-1',
    });

    expect(posted).toBe(true);
    expect(proposalId).toBeTruthy();
    expect((await getProposalStatus('knowledge', proposalId))).toMatchObject({ ok: true, status: 'pending' });

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(cardType).toBe('knowledge_proposal'); // 契约：γ 轨道依赖，不得偏离
    expect(content).toContain('## 📚 知识提案 — 待人工审核');
    expect(content).toContain('1. **session 过期未刷新导致 401**（pitfall）');
    expect(content).toContain('2. **登录流程统一走 auth-service**（guideline）');
    expect(content).toContain('来源 WorkUnit: wu-1');
    expect(content).toContain('审核通过后参与知识注入；拒绝则归档，不再注入。');
    expect(cardData).toEqual({
      proposalId,
      entries: ENTRIES,
      workUnitId: 'wu-1',
      source: 'conversation:wu-1',
    });
  });

  it('workUnitId 缺省 → 文案 unknown、cardData null（同旧行为）', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);

    await submitKnowledgeProposal(ENTRIES, { source: 'conversation:unknown' });

    const [, , content, , cardData] = mockCreateCardMessage.mock.calls[0];
    expect(content).toContain('来源 WorkUnit: unknown');
    expect(cardData.workUnitId).toBeNull();
  });

  it('空条目 → 静默跳过（不建提案、不发卡、不抛）', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);

    const { proposalId, posted } = await submitKnowledgeProposal([], { source: 'conversation:wu-x' });

    expect(posted).toBe(false);
    expect(proposalId).toBe('');
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, 'knowledge-proposals.jsonl'))).toBe(false);
  });

  it('#系统 频道缺失 → posted=false，落 card-failed 墓碑不抛（提取链路不被通知阻断）', async () => {
    listChannelsSpy.mockResolvedValue([]);

    const { proposalId, posted } = await submitKnowledgeProposal(ENTRIES, {
      workUnitId: 'wu-2', source: 'conversation:wu-2',
    });

    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect((await getProposalStatus('knowledge', proposalId))).toMatchObject({ ok: true, status: 'card-failed' });
  });
});

describe('正本生命周期全链路（kind=knowledge，通用端点同款 service 驱动）', () => {
  beforeEach(() => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
  });

  it('建提案 → approve → executed + 逐条目 promote（draft→verified，参与注入）', async () => {
    const { proposalId } = await submitKnowledgeProposal(ENTRIES, {
      workUnitId: 'wu-1', source: 'conversation:wu-1',
    });

    const approved = await approveProposal('knowledge', proposalId);
    expect(approved).toMatchObject({ kind: 'executed' });

    expect((await getProposalStatus('knowledge', proposalId))).toMatchObject({ ok: true, status: 'executed' });
    expect(mockPromote).toHaveBeenCalledTimes(2);
    expect(mockPromote).toHaveBeenCalledWith('k-1');
    expect(mockPromote).toHaveBeenCalledWith('k-2');
    expect(mockDemote).not.toHaveBeenCalled();

    // 重复 approve → not-pending 闸（正本词表）
    const again = await approveProposal('knowledge', proposalId);
    expect(again).toMatchObject({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('reject → rejected 墓碑 + 逐条目 demote（draft→archived，不再注入）', async () => {
    const { proposalId } = await submitKnowledgeProposal(ENTRIES, {
      workUnitId: 'wu-1', source: 'conversation:wu-1',
    });

    expect(await rejectProposal('knowledge', proposalId)).toEqual({ ok: true });
    expect((await getProposalStatus('knowledge', proposalId))).toMatchObject({ ok: true, status: 'rejected' });
    expect(mockDemote).toHaveBeenCalledTimes(2);
    expect(mockDemote).toHaveBeenCalledWith('k-1');
    expect(mockDemote).toHaveBeenCalledWith('k-2');
    expect(mockPromote).not.toHaveBeenCalled();

    const again = await rejectProposal('knowledge', proposalId);
    expect(again).toMatchObject({ ok: false, error: 'proposal-not-pending:rejected' });
  });

  it('promote 抛错 → failed 墓碑（正本词表），错误透传', async () => {
    mockPromote.mockRejectedValueOnce(new Error('store gone'));
    const { proposalId } = await submitKnowledgeProposal(ENTRIES, {
      workUnitId: 'wu-1', source: 'conversation:wu-1',
    });

    const approved = await approveProposal('knowledge', proposalId);
    expect(approved).toMatchObject({ kind: 'failed', error: 'store gone' });
    expect((await getProposalStatus('knowledge', proposalId))).toMatchObject({ ok: true, status: 'failed' });
  });

  it('查无提案 → proposal-not-found；status → unknown', async () => {
    expect(await approveProposal('knowledge', 'ghost')).toMatchObject({ kind: 'invalid', error: 'proposal-not-found' });
    expect((await getProposalStatus('knowledge', 'ghost'))).toMatchObject({ ok: true, status: 'unknown' });
  });
});
