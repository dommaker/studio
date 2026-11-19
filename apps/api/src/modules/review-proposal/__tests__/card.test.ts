/**
 * review-proposal/card (#351) — 通用提案人审卡投放测试
 *
 * 覆盖自三张旧卡（distill-proposal-card/gc-proposal-card/constraint-audit-card）同构用例收敛：
 *   - #系统 频道存在 → 发卡（cardType/content/cardData 原样透传）
 *   - #系统 频道缺失 → 静默 false，不抛（不发卡）
 *   - 发卡异常 → 静默 false，不抛
 *   - 卡 poster 未注册 → 与发卡失败同口径：静默 false + warn
 * （Phase 5 SCC 第一刀 #3：发卡经装配注入的 ChannelCardPoster，测试内注册 mock poster）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockCreateCardMessage, mockLogger } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: mockLogger };
});

import { postReviewProposalCard, registerChannelCardPoster } from '../card.js';

let tmpDir: string;
let fileStore: FileStore;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-card-'));
  fileStore = new FileStore(tmpDir);
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
  registerChannelCardPoster((post) =>
    mockCreateCardMessage(post.channelId, post.author, post.content, post.cardType, post.cardData),
  );
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

describe('postReviewProposalCard', () => {
  it('#系统 频道存在 → 发卡（cardType/content/cardData 原样透传），返回 true', async () => {
    await seedSystemChannel();
    const posted = await postReviewProposalCard(
      { cardType: 'distill_proposal', content: '## 提案正文', cardData: { proposalId: 'p-1' }, logTag: 'test' },
      { fileStore },
    );
    expect(posted).toBe(true);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, sender, content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-system');
    expect(sender).toBe('KK');
    expect(content).toBe('## 提案正文');
    expect(cardType).toBe('distill_proposal');
    expect(cardData).toEqual({ proposalId: 'p-1' });
  });

  it('#系统 频道缺失 → 静默 false，不抛（不发卡）', async () => {
    const posted = await postReviewProposalCard(
      { cardType: 'gc_proposal', content: 'x', cardData: {} },
      { fileStore },
    );
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('createCardMessage 抛错 → 静默 false，不抛', async () => {
    await seedSystemChannel();
    mockCreateCardMessage.mockRejectedValue(new Error('disk full'));
    const posted = await postReviewProposalCard(
      { cardType: 'gc_proposal', content: 'x', cardData: {} },
      { fileStore },
    );
    expect(posted).toBe(false);
  });

  it('卡 poster 未注册 → 与发卡失败同口径：静默 false + warn，不抛', async () => {
    await seedSystemChannel();
    registerChannelCardPoster(null);

    const posted = await postReviewProposalCard(
      { cardType: 'gc_proposal', content: 'x', cardData: {} },
      { fileStore },
    );
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to post proposal card'),
      expect.objectContaining({ error: expect.stringContaining('未注册') }),
    );
  });
});
