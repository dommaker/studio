/**
 * distill-proposal-card (#143) — 蒸馏提案卡降级路径测试
 *
 * 覆盖（同 #101 memory-proposal-card 降级口径）：
 *   - 正常发卡：cardType=distill_proposal，cardData 带 proposalId + 原料清单 + 命中信号
 *   - #系统 频道缺失 → 返回 false 静默跳过（不调用 channelMessageService）
 *   - createCardMessage 抛错 → 返回 false 不抛
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

import { postDistillProposalCard } from '../distill-proposal-card.js';
import type { DistillProposal } from '../distill-store.js';

const proposal: DistillProposal = {
  id: 'dp-1',
  createdAt: new Date().toISOString(),
  materialIds: ['ore-1', 'ore-2'],
  materials: [{ id: 'ore-1', title: '[Session Fix] 修复竞态' }, { id: 'ore-2', title: '[Session Fix] 修复超时' }],
  signals: { topicTags: ['session-summary'], manualCount: 0 },
  triggerWorkUnitId: 'wu-1',
};

let tmpDir: string;
let fileStore: FileStore;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-card-'));
  fileStore = new FileStore(tmpDir);
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
});

afterEach(() => {
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

describe('postDistillProposalCard', () => {
  it('正常发卡：distill_proposal 卡带 proposalId/原料清单/信号，内容含原料与预期产出', async () => {
    await seedSystemChannel();
    const posted = await postDistillProposalCard(proposal, { fileStore });
    expect(posted).toBe(true);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-system');
    expect(cardType).toBe('distill_proposal');
    expect(cardData.proposalId).toBe('dp-1');
    expect(cardData.materials).toHaveLength(2);
    expect(cardData.signals.topicTags).toEqual(['session-summary']);
    expect(cardData.workUnitId).toBe('wu-1');
    expect(content).toContain('原料');
    expect(content).toContain('预期产出');
    expect(content).toContain('[Session Fix] 修复竞态');
  });

  it('#系统 频道缺失 → false 静默跳过（不调 channelMessageService）', async () => {
    const posted = await postDistillProposalCard(proposal, { fileStore });
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('createCardMessage 抛错 → false 不抛（发卡失败静默）', async () => {
    await seedSystemChannel();
    mockCreateCardMessage.mockRejectedValue(new Error('disk full'));
    const posted = await postDistillProposalCard(proposal, { fileStore });
    expect(posted).toBe(false);
  });
});
