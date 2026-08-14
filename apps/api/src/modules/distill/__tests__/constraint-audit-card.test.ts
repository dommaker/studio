/**
 * constraint-audit-card (#146) — 审计人审卡投放测试：
 * 发卡成功（cardData 形状 + 判据理由进正文）/ 频道缺失静默 / 发卡失败静默（#101 降级口径）
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

import { postConstraintAuditCard } from '../constraint-audit-card.js';
import type { ConstraintAuditProposal } from '../audit-store.js';

let tmpDir: string;
let fileStore: FileStore;

const proposal: ConstraintAuditProposal = {
  id: 'audit-1',
  createdAt: new Date().toISOString(),
  runId: 'run-1',
  suggestions: [
    { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' },
  ],
  auditedCount: 7,
};

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-card-'));
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

describe('postConstraintAuditCard', () => {
  it('#系统 频道存在 → 发 constraint_audit_proposal 卡（建议+判据理由进 cardData 与正文）', async () => {
    await seedSystemChannel();

    const posted = await postConstraintAuditCard(proposal, { fileStore });
    expect(posted).toBe(true);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-system');
    expect(cardType).toBe('constraint_audit_proposal');
    expect(cardData.auditProposalId).toBe('audit-1');
    expect(cardData.runId).toBe('run-1');
    expect(cardData.suggestions).toHaveLength(1);
    expect(content).toContain('prisma_schema_needs_migration');
    expect(content).toContain('作用对象已消失');
    expect(content).toContain('schema.prisma 已从代码库删除');
  });

  it('#系统 频道缺失 → 静默 false，不抛', async () => {
    const posted = await postConstraintAuditCard(proposal, { fileStore });
    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('发卡异常 → 静默 false，不抛', async () => {
    await seedSystemChannel();
    mockCreateCardMessage.mockRejectedValue(new Error('channel write failed'));
    const posted = await postConstraintAuditCard(proposal, { fileStore });
    expect(posted).toBe(false);
  });
});
