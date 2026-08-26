/**
 * review-adapter (#353) — role-memory 接线 review-proposal 正本的行为级测试
 *
 * 契约（ADR 2026-08-25 决策 2/3/4）：
 *   - 提案 = 草稿条目（id=draftId），存取仍落 per-role draft.jsonl（存量历史行不改写）；
 *     旧 promoted 墓碑读侧归一为 executed（决策 3），正本 kind:'status' 状态行直取。
 *   - 一批 manual 草稿聚合一张 memory_proposal 卡（cardData 形状同 #101 旧卡：roleId/entries/workUnitId/source），
 *     发卡经正本 postReviewProposalCard；发卡失败落 card-failed 墓碑不抛（#101/#143 降级口径）。
 *   - approve/reject/status 全走正本通用生命周期（kind='memory'）：approve→promote 副作用 /
 *     reject→demote 副作用，词表 pending|executed|rejected|failed|card-failed。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { mockCreateCardMessage } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

import { FileStore } from '@dommaker/studio-shared';
import { clearReviewProposalAdapters } from '../../review-proposal/registry.js';
import { approveProposal, rejectProposal, getProposalStatus } from '../../review-proposal/service.js';
import {
  foldDraftRows,
  roleMemoryRoot,
  roleMemoryStore,
  type MemoryDraftLine,
} from '../role-memory.js';
import {
  MemoryProposalStore,
  registerMemoryReviewAdapter,
  submitMemoryProposal,
} from '../review-adapter.js';

const TEST_ROOT = roleMemoryRoot();

/** 每用例唯一角色 id，防跨用例/跨文件（并行 worker 共享 TEST_ROOT）串扰；登记供 afterAll 定向清理 */
const createdRoleIds: string[] = [];
function freshRoleId(): string {
  const id = `adapter-role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdRoleIds.push(id);
  return id;
}

let fileStore: FileStore;
let listChannelsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearReviewProposalAdapters();
  fileStore = new FileStore();
  // 发卡频道解析走 adapter.fileStore.listChannels——spy 控制 #系统 频道有无，其余 FileStore I/O 全真
  listChannelsSpy = vi.spyOn(fileStore, 'listChannels').mockResolvedValue([]);
  // 预注册受控 adapter：submitMemoryProposal 优先取注册表（getReviewProposalAdapter），不自助注册
  registerMemoryReviewAdapter({ fileStore });
});

afterAll(() => {
  for (const id of createdRoleIds) {
    fs.rmSync(path.join(TEST_ROOT, id), { recursive: true, force: true });
  }
});

/** 直接往 draft.jsonl 塞原始行（构造存量历史形态：旧墓碑行 / 正本状态行） */
async function seedRows(roleId: string, rows: MemoryDraftLine[]): Promise<void> {
  const fs2 = new FileStore();
  for (const row of rows) {
    await fs2.appendJsonl(path.join(TEST_ROOT, roleId, 'draft.jsonl'), row);
  }
}

describe('foldDraftRows — draft.jsonl 读侧归一（ADR 决策 3）', () => {
  it('plain 条目行 → pending；旧 promoted 墓碑 → executed；旧 rejected 墓碑 → rejected', () => {
    const rows: MemoryDraftLine[] = [
      { id: 'p', roleId: 'r', kind: 'execution-knowledge', title: 'P', content: 'p', review: 'manual', createdAt: 't0' },
      { id: 'a', roleId: 'r', kind: 'execution-knowledge', title: 'A', content: 'a', review: 'manual', createdAt: 't0' },
      { id: 'a', roleId: 'r', kind: 'execution-knowledge', title: 'A', content: 'a', review: 'manual', createdAt: 't0', promoted: true, promotedAt: 't1' },
      { id: 'x', roleId: 'r', kind: 'preference', title: 'X', content: 'x', review: 'manual', createdAt: 't0' },
      { id: 'x', roleId: 'r', kind: 'preference', title: 'X', content: 'x', review: 'manual', createdAt: 't0', rejected: true, rejectedAt: 't2' },
    ];
    const fold = foldDraftRows(rows);
    expect(fold.get('p')?.status).toBe('pending');
    expect(fold.get('a')?.status).toBe('executed'); // promoted 读侧归一
    expect(fold.get('a')?.statusAt).toBe('t1');
    expect(fold.get('x')?.status).toBe('rejected');
  });

  it('正本 kind:status 状态行直取（card-failed/failed 超集词表）', () => {
    const rows: MemoryDraftLine[] = [
      { id: 'c', roleId: 'r', kind: 'execution-knowledge', title: 'C', content: 'c', review: 'manual', createdAt: 't0' },
      { kind: 'status', id: 'c', status: 'card-failed', at: 't1' },
      { id: 'f', roleId: 'r', kind: 'execution-knowledge', title: 'F', content: 'f', review: 'manual', createdAt: 't0' },
      { kind: 'status', id: 'f', status: 'failed', at: 't2' },
    ];
    const fold = foldDraftRows(rows);
    expect(fold.get('c')?.status).toBe('card-failed');
    expect(fold.get('f')?.status).toBe('failed');
  });
});

describe('MemoryProposalStore — per-role draft.jsonl 存取', () => {
  it('getProposal 跨角色定位；读侧归一旧 promoted → executed；查无 → null', async () => {
    const store = new MemoryProposalStore(fileStore);
    const roleId = freshRoleId();
    const entry = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'S1', content: 's1' });
    // 存量历史形态：旧 promote 墓碑行（不改写，读侧归一）
    await roleMemoryStore.promote(roleId, [entry.id]);

    const found = await store.getProposal(entry.id);
    expect(found?.status).toBe('executed');
    expect(found?.roleId).toBe(roleId);
    expect(await store.getProposal('no-such-id')).toBeNull();
  });

  it('appendStatus 落条目所属角色的 draft.jsonl（kind:status 行）', async () => {
    const store = new MemoryProposalStore(fileStore);
    const roleId = freshRoleId();
    const entry = await roleMemoryStore.appendDraft(roleId, { kind: 'execution-knowledge', title: 'S2', content: 's2' });

    await store.appendStatus(entry.id, 'card-failed');
    expect((await store.getProposal(entry.id))?.status).toBe('card-failed');
    // readDraft 同步排除（status 行 = 终态墓碑）
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
  });

  it('appendStatus 查无条目 → 抛（正本只在 getProposal 命中后调用）', async () => {
    const store = new MemoryProposalStore(fileStore);
    await expect(store.appendStatus('ghost', 'executed')).rejects.toThrow('memory-proposal-not-found');
  });
});

describe('submitMemoryProposal — 一批草稿聚合一卡（行为同 #101 旧卡）', () => {
  it('两条 manual → 条目落 draft.jsonl（pending）+ 一张 memory_proposal 卡（cardData 形状不变）', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
    const roleId = freshRoleId();

    const entries = await submitMemoryProposal(roleId, [
      { kind: 'execution-knowledge', title: 'Testing Command', content: 'pnpm test:api' },
      { kind: 'preference', title: '命名约定', content: '分支名 feat/<n>-<slug>', topicSlug: 'naming' },
    ], { workUnitId: 'wu-1', source: 'wu-completion' });

    expect(entries).toHaveLength(2);
    // 条目行 = 提案行（pending，可被通用端点审批）
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(2);

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(cardType).toBe('memory_proposal');
    expect(content).toContain('Testing Command');
    expect(content).toContain('topics/testing-command.md');
    expect(content).not.toContain('execution-knowledge');
    expect(cardData).toMatchObject({ roleId, workUnitId: 'wu-1', source: 'wu-completion' });
    expect(cardData.entries).toHaveLength(2);
    expect(cardData.entries[0]).toMatchObject({
      draftId: entries[0].id, title: 'Testing Command', topicSlug: 'testing-command',
      topicPath: 'topics/testing-command.md', kind: 'execution-knowledge',
    });
    expect(cardData.entries[1]).toMatchObject({
      draftId: entries[1].id, title: '命名约定', topicSlug: 'naming',
      topicPath: 'topics/naming.md', kind: 'preference',
    });
  });

  it('空 inputs → 不写草稿不发卡', async () => {
    const entries = await submitMemoryProposal(freshRoleId(), [], { source: 'x' });
    expect(entries).toEqual([]);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('#系统 频道缺失 → 不抛，落 card-failed 墓碑（提取链路不被通知阻断）', async () => {
    listChannelsSpy.mockResolvedValue([]);
    const roleId = freshRoleId();
    const entries = await submitMemoryProposal(roleId, [
      { kind: 'execution-knowledge', title: 'No Channel', content: 'c' },
    ], { source: 'wu-completion' });

    expect(entries).toHaveLength(1);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    const adapter = registerMemoryReviewAdapter({ fileStore });
    expect((await adapter.store.getProposal(entries[0].id))?.status).toBe('card-failed');
  });
});

describe('正本生命周期全链路（kind=memory，通用端点同款 service 驱动）', () => {
  beforeEach(() => {
    // 发卡成功，提案保持 pending 进入人审
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
  });

  it('建提案 → approve → executed + topic/索引合并（promote 副作用）+ readDraft 排除', async () => {
    const roleId = freshRoleId();
    const [entry] = await submitMemoryProposal(roleId, [
      { kind: 'execution-knowledge', title: 'Full Flow', content: 'content-full' },
    ], { workUnitId: 'wu-9', source: 'wu-completion' });

    expect((await getProposalStatus('memory', entry.id))).toMatchObject({ ok: true, status: 'pending' });

    const approved = await approveProposal('memory', entry.id);
    expect(approved).toMatchObject({ kind: 'executed' });

    expect((await getProposalStatus('memory', entry.id))).toMatchObject({ ok: true, status: 'executed' });
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
    expect(await roleMemoryStore.readIndex(roleId)).toContain('full-flow');

    // 重复 approve → not-pending 闸（正本词表）
    const again = await approveProposal('memory', entry.id);
    expect(again).toMatchObject({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('reject → rejected + demote 副作用（readDraft 排除，不写索引）', async () => {
    const roleId = freshRoleId();
    const [entry] = await submitMemoryProposal(roleId, [
      { kind: 'preference', title: 'Reject Me', content: 'content-rej' },
    ], { source: 'wu-completion' });

    expect(await rejectProposal('memory', entry.id)).toEqual({ ok: true });
    expect((await getProposalStatus('memory', entry.id))).toMatchObject({ ok: true, status: 'rejected' });
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
    expect(await roleMemoryStore.readIndex(roleId)).toBe('');

    const again = await rejectProposal('memory', entry.id);
    expect(again).toMatchObject({ ok: false, error: 'proposal-not-pending:rejected' });
  });

  it('查无提案 → proposal-not-found；status → unknown 由路由层兜底（service 直返）', async () => {
    registerMemoryReviewAdapter({ fileStore });
    expect(await approveProposal('memory', 'ghost')).toMatchObject({ kind: 'invalid', error: 'proposal-not-found' });
    expect((await getProposalStatus('memory', 'ghost'))).toMatchObject({ ok: true, status: 'unknown' });
  });
});
