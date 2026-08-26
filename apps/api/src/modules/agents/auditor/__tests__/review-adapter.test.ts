/**
 * review-adapter (#356) — auditor_suggestion 提案卡接线 review-proposal 正本的行为级测试
 *
 * 契约（ADR docs/adr/2026-08-25-review-proposal-lifecycle-module.md 决策 2/4）：
 *   - 提案存取/发卡/approve/reject/status 全归 review-proposal 正本（kind='auditor'）；
 *     存储物化 <dataDir>/auditor-proposals.jsonl（append-only），词表 pending|executed|rejected|failed|card-failed。
 *   - 业务方只保留「卡片内容」（auditor_suggestion 卡文案原样保留，cardData = { proposalId, suggestions }）
 *     与「审批后动作」（onApprove → 本频道建 type:task 未指派工单，自旧 card-decision.service
 *     confirm 分支原样搬入；onReject → 零副作用，拒绝 = 仅留痕墓碑归正本）。
 *   - 发卡失败落 card-failed 墓碑不抛（#101/#143 降级口径，审计链路不被通知阻断）。
 *
 * 新旧覆盖对照（删旧测前的映射，过 no_test_simplification 闸）：
 *   - card-decision.service.test「confirm 建工单（正文含建议详情+原卡链接）/ reject 仅留痕 /
 *     已决定再决策抛 already / 消息不存在抛 not found」→ 本文件「approve 全链路 / reject 零副作用 /
 *     非 pending 闸 / 卡消息缺失兜底 + 频道缺失 aborted」用例（幂等/存在性闸归正本 approveProposal）
 *   - auditor-agent.test「pushConfirmationCards 发卡」→ 同文件保留（改经正本链路，增 proposalId 断言）
 *   - meta.status 回写 confirmed/rejected + SSE 推送用例 → 废止：已审态改由前端查提案状态派生
 *     （ADR 决策 6「打开时查一次」，同 #355 knowledge 口径），不再有 meta.status 写入点
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCreateCardMessage } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn(),
}));

// 单例发卡走 mock（断言 + 重定向到测试 fileStore）；ChannelMessageService 类保持真实
// （wireCardPostingToRealStore 用真类把卡片落进测试 fileStore）
vi.mock('../../../channels/channel-message.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../channels/channel-message.service.js')>();
  return { ...actual, channelMessageService: { createCardMessage: mockCreateCardMessage } };
});

import { FileStore } from '@dommaker/studio-shared';
import { ChannelMessageService } from '../../../channels/channel-message.service.js';
import { clearReviewProposalAdapters } from '../../../review-proposal/registry.js';
import { approveProposal, rejectProposal, getProposalStatus } from '../../../review-proposal/service.js';
import { registerAuditorReviewAdapter, submitAuditorSuggestionProposal } from '../review-adapter.js';
import type { Suggestion } from '../auditor-rules.js';

const SUGGESTIONS: Suggestion[] = [
  { type: 'param_tuning', risk: 'low', agentType: 'developer', detail: '调低重试上限到 2' },
  { type: 'skill_status', risk: 'high', skillId: 'skill-9', skillName: 'legacy-x', detail: '下线 legacy-x 技能' },
];

let tmpRoot: string;
let dataDir: string;
let fileStore: FileStore;
let channelId: string;

/** 发卡落真：正本动态 import 的单例被 mock，这里把卡片真实写进测试 fileStore（卡片定位/作者断言需要真消息） */
function wireCardPostingToRealStore(): void {
  const realMessageService = new ChannelMessageService(fileStore);
  mockCreateCardMessage.mockImplementation(
    (chId: string, author: string, content: string, cardType: string, cardData: Record<string, unknown>) =>
      realMessageService.createCardMessage(chId, author, content, cardType, cardData),
  );
}

async function createSystemChannel(): Promise<void> {
  channelId = `ch-sys-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReviewProposalAdapters();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-review-adapter-'));
  dataDir = path.join(tmpRoot, 'data');
  fileStore = new FileStore(tmpRoot);
  registerAuditorReviewAdapter({ fileStore, dataDir });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('submitAuditorSuggestionProposal — 建提案 + 发卡（行为同旧 auditor_suggestion 卡）', () => {
  it('提案落 pending + 发卡：作者 Auditor / cardType / 文案不变，cardData = { proposalId, suggestions }', async () => {
    await createSystemChannel();
    wireCardPostingToRealStore();

    const { proposalId, posted } = await submitAuditorSuggestionProposal(SUGGESTIONS);

    expect(posted).toBe(true);
    expect(proposalId).toBeTruthy();
    expect(await getProposalStatus('auditor', proposalId)).toMatchObject({ ok: true, status: 'pending' });

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [chId, author, content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(chId).toBe(channelId);
    expect(author).toBe('Auditor');
    expect(cardType).toBe('auditor_suggestion');
    expect(content).toContain('## 🔧 审计建议 — 待人工确认');
    expect(content).toContain('调低重试上限到 2');
    expect(content).toContain('请确认是否执行以上建议。');
    expect(cardData).toMatchObject({ proposalId });
    expect((cardData as { suggestions: Suggestion[] }).suggestions).toHaveLength(2);
  });

  it('空建议 → 早退：不建提案不发卡（旧 pushConfirmationCards 同款早退）', async () => {
    await createSystemChannel();
    const { proposalId, posted } = await submitAuditorSuggestionProposal([]);
    expect(proposalId).toBe('');
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('#系统 频道缺失 → posted=false + card-failed 墓碑（#101/#143 降级口径，不抛）', async () => {
    const { proposalId, posted } = await submitAuditorSuggestionProposal(SUGGESTIONS);
    expect(posted).toBe(false);
    expect(proposalId).toBeTruthy();
    expect(await getProposalStatus('auditor', proposalId)).toMatchObject({ ok: true, status: 'card-failed' });
  });
});

describe('approve — onApprove 建未指派 task 工单（自旧 card-decision confirm 分支搬入）', () => {
  it('全链路：submit → approve → 本频道 type:task 未指派工单 + 状态 executed + 响应带 workUnitId', async () => {
    await createSystemChannel();
    wireCardPostingToRealStore();
    const { proposalId } = await submitAuditorSuggestionProposal(SUGGESTIONS);
    const cardMessageId = mockCreateCardMessage.mock.calls[0] ?
      (await fileStore.queryMessages(channelId)).find(m => {
        const meta = typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta;
        return meta?.cardData?.proposalId === proposalId;
      })!.id : '';

    const result = await approveProposal('auditor', proposalId);

    expect(result).toMatchObject({ kind: 'executed' });
    const workUnitId = (result as { data?: { workUnitId?: string } }).data?.workUnitId;
    expect(workUnitId).toBeTruthy();
    expect(await getProposalStatus('auditor', proposalId)).toMatchObject({ ok: true, status: 'executed' });

    const wu = (await fileStore.getIndex()).find(s => s.id === workUnitId);
    expect(wu).toBeTruthy();
    expect(wu!.channelId).toBe(channelId);
    expect(wu!.type).toBe('task');
    expect(wu!.status).toBe('unassigned');
    expect(wu!.assigneeId ?? null).toBeNull();
    const metadata = typeof wu!.metadata === 'string' ? JSON.parse(wu!.metadata) : wu!.metadata;
    expect(metadata.creationMode).toBe('card-decision');
    expect(metadata.originalMessageId).toBe(cardMessageId);
    // 正文 = 建议详情 + 原卡链接（旧 card-decision 口径）
    expect(metadata.description).toContain('调低重试上限到 2');
    expect(metadata.description).toContain('下线 legacy-x 技能');
    expect(metadata.description).toContain(`原卡：频道 ${channelId} 消息 ${cardMessageId}`);
  });

  it('非 pending 提案再 approve → invalid（幂等闸归正本）', async () => {
    await createSystemChannel();
    wireCardPostingToRealStore();
    const { proposalId } = await submitAuditorSuggestionProposal(SUGGESTIONS);
    await approveProposal('auditor', proposalId);
    const again = await approveProposal('auditor', proposalId);
    expect(again).toMatchObject({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('卡消息已删/归档 → 仍建工单（兜底：提案是合法 pending，审批不被卡消息存续阻断），无原卡链接', async () => {
    await createSystemChannel();
    // 不 wire 发卡 —— 提案落 pending 但频道里查不到卡消息（模拟卡被删/归档）
    mockCreateCardMessage.mockResolvedValue({});
    const { proposalId } = await submitAuditorSuggestionProposal(SUGGESTIONS);

    const result = await approveProposal('auditor', proposalId);

    expect(result).toMatchObject({ kind: 'executed' });
    const workUnitId = (result as { data?: { workUnitId?: string } }).data?.workUnitId;
    const wu = (await fileStore.getIndex()).find(s => s.id === workUnitId);
    const metadata = typeof wu!.metadata === 'string' ? JSON.parse(wu!.metadata) : wu!.metadata;
    expect(metadata.creationMode).toBe('card-decision');
    expect(metadata.originalMessageId).toBeUndefined();
    expect(metadata.description).toContain('调低重试上限到 2');
  });

  it('#系统 频道缺失 → aborted：不落墓碑，提案保持 pending 可重试', async () => {
    await createSystemChannel();
    wireCardPostingToRealStore();
    const { proposalId } = await submitAuditorSuggestionProposal(SUGGESTIONS);

    // 换用一个没有 #系统 频道的 fileStore 重注册（提案存取在 dataDir 共享，频道解析走新 store）
    const loneStore = new FileStore(path.join(tmpRoot, 'lone'));
    registerAuditorReviewAdapter({ fileStore: loneStore, dataDir });

    const result = await approveProposal('auditor', proposalId);
    expect(result).toMatchObject({ kind: 'aborted' });
    // 不落墓碑：提案保持 pending（装配修复后可重试）
    expect(await getProposalStatus('auditor', proposalId)).toMatchObject({ ok: true, status: 'pending' });
  });
});

describe('reject — 仅留痕（墓碑归正本，零业务副作用）', () => {
  it('reject → rejected 墓碑 + 不建工单', async () => {
    await createSystemChannel();
    wireCardPostingToRealStore();
    const { proposalId } = await submitAuditorSuggestionProposal(SUGGESTIONS);

    const result = await rejectProposal('auditor', proposalId);

    expect(result).toMatchObject({ ok: true });
    expect(await getProposalStatus('auditor', proposalId)).toMatchObject({ ok: true, status: 'rejected' });
    expect((await fileStore.getIndex()).filter(s => s.channelId === channelId)).toHaveLength(0);
  });
});
