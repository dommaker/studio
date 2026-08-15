/**
 * gc-proposal-card (#144) — GC 人审卡投放测试：
 * 发卡成功（cardData 形状）/ 频道缺失静默 / 发卡失败静默（#101 降级口径）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockCreateCardMessage } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn(),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

import { postGcProposalCard } from '../gc-proposal-card.js';
import type { GcProposal } from '../gc-store.js';

let tmpDir: string;
let fileStore: FileStore;

const proposal: GcProposal = {
  id: 'gc-1',
  createdAt: new Date().toISOString(),
  runId: 'run-1',
  candidates: [
    { entryId: 'e1', title: '过时条目', zeroRefStreak: 3, zeroRefCycles: ['2026-07-01T00:00:00.000Z'], reason: '连续 3 个蒸馏周期零引用（lastReferenced 停留在 2026-06-01）' },
  ],
  forced: false,
  mainAreaCount: 42,
};

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-card-'));
  fileStore = new FileStore(tmpDir);
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('postGcProposalCard', () => {
  it('#系统 频道存在 → 发 gc_proposal 卡（候选+理由进 cardData 与正文）', async () => {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-system', name: '#系统', type: 'system',
      defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: now, updatedAt: now,
    });

    const posted = await postGcProposalCard(proposal, { fileStore });
    expect(posted).toBe(true);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-system');
    expect(cardType).toBe('gc_proposal');
    expect(cardData.gcProposalId).toBe('gc-1');
    expect(cardData.runId).toBe('run-1');
    expect(cardData.candidates).toHaveLength(1);
    expect(content).toContain('过时条目');
    expect(content).toContain('连续 3 个蒸馏周期零引用');
  });

  it('#系统 频道缺失 → 静默 false，不抛', async () => {
    const posted = await postGcProposalCard(proposal, { fileStore });
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('发卡异常 → 静默 false，不抛', async () => {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-system', name: '#系统', type: 'system',
      defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: now, updatedAt: now,
    });
    mockCreateCardMessage.mockRejectedValue(new Error('channel write failed'));
    const posted = await postGcProposalCard(proposal, { fileStore });
    expect(posted).toBe(false);
  });
});
