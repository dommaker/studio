/**
 * memory-proposal-card (#101) — 角色记忆人审提案卡单测
 *
 * 契约：cardType 'memory_proposal'；cardData.entries 指向「文件 + 段落」
 * （draftId/title/topicSlug/topicPath/kind），approve/reject 用 draftId 接线
 * （role-memory.routes promote/demote）。卡文案人类可读（不出现 execution-knowledge 等内部分类词）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListChannels, mockCreateCardMessage } = vi.hoisted(() => ({
  mockListChannels: vi.fn().mockResolvedValue([]),
  mockCreateCardMessage: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () {
      return { listChannels: mockListChannels };
    }),
  };
});

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

import { postMemoryProposalCard } from '../memory-proposal-card.js';
import type { MemoryDraftEntry } from '../role-memory.js';

function makeEntry(over: Partial<MemoryDraftEntry> = {}): MemoryDraftEntry {
  return {
    id: 'd-1',
    roleId: 'role-1',
    kind: 'execution-knowledge',
    title: '测试命令',
    content: 'pnpm test:api',
    review: 'manual',
    createdAt: 'x',
    ...over,
  };
}

describe('postMemoryProposalCard (#101 记忆提案卡)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChannels.mockResolvedValue([]);
  });

  it('manual 条目 → 发 memory_proposal 卡，cardData 指文件+段落', async () => {
    mockListChannels.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
    await postMemoryProposalCard(
      [
        makeEntry({ title: 'Testing Command' }),
        makeEntry({ id: 'd-2', kind: 'preference', title: '命名约定', topicSlug: 'naming' }),
      ],
      { workUnitId: 'wu-1', source: 'wu-completion' },
    );

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, agentName, content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(cardType).toBe('memory_proposal');
    // 文案含标题 + 文件路径，且无内部分类词
    expect(content).toContain('Testing Command');
    expect(content).toContain('topics/testing-command.md');
    expect(content).toContain('topics/naming.md');
    expect(content).not.toContain('execution-knowledge');
    expect(content).not.toContain('preference');
    expect(content).not.toContain('auto');
    expect(content).not.toContain('manual');

    expect(cardData.roleId).toBe('role-1');
    expect(cardData.workUnitId).toBe('wu-1');
    expect(cardData.entries).toHaveLength(2);
    expect(cardData.entries[0]).toMatchObject({
      draftId: 'd-1', title: 'Testing Command', topicSlug: 'testing-command',
      topicPath: 'topics/testing-command.md', kind: 'execution-knowledge',
    });
    expect(cardData.entries[1]).toMatchObject({
      draftId: 'd-2', title: '命名约定', topicSlug: 'naming',
      topicPath: 'topics/naming.md', kind: 'preference',
    });
  });

  it('空条目 → 不发卡', async () => {
    await postMemoryProposalCard([], { workUnitId: 'wu-1', source: 'x' });
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('#系统 频道缺失 → 静默跳过，不抛', async () => {
    mockListChannels.mockResolvedValue([]);
    await expect(postMemoryProposalCard([makeEntry()], { workUnitId: 'wu-1', source: 'x' })).resolves.not.toThrow();
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });
});
