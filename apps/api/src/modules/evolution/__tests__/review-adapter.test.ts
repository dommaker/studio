/**
 * evolution review-adapter 测试（#623：evolution 归位 review-proposal 正本卡片）
 *
 * 覆盖：
 *   - EvolutionProposalStore 读侧归一（applied→executed / approved→pending 可重试 /
 *     rejected→rejected / stale→stale 原值保留）与 appendStatus no-op
 *   - renderCardContent：当前/提案/理由/证据窗口 + cardData（proposalId 接线通用端点）
 *   - runScan 发布路径：新提案发 evolution_proposal 卡到 #系统（替代旧频道文本消息）
 *   - 端到端：建提案 → 发卡 → 正本 approveProposal → EvolutionService.decide → applied 落盘
 *   - 正本 rejectProposal → decide → rejected
 *   - APPLY_FAILED：approve 失败 outcome=failed，提案停 approved（读侧归一 pending 可重试）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, formatEvolutionId, type EvolutionProposalData } from '@dommaker/studio-shared';
import { approveProposal, rejectProposal, getProposalStatus } from '../../review-proposal/service.js';
import { clearReviewProposalAdapters } from '../../review-proposal/registry.js';
import { EvolutionService } from '../evolution.service.js';
import {
  EvolutionProposalStore,
  registerEvolutionReviewAdapter,
  toReviewProposalStatus,
} from '../review-adapter.js';
import { resolveEvolutionPaths, type EvolutionPaths } from '../signals.js';

const { mockCreateCardMessage } = vi.hoisted(() => ({ mockCreateCardMessage: vi.fn() }));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

let tmpDir: string;
let fileStore: FileStore;
let service: EvolutionService;
let paths: EvolutionPaths;
let prevEnv: string | undefined;

async function seedProposal(patch?: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
  const seq = await fileStore.allocateEvolutionSeq();
  const p: EvolutionProposalData = {
    id: formatEvolutionId(seq),
    seq,
    targetType: 'prompt-template',
    targetId: 'tpl-review',
    action: 'amend',
    currentText: '旧模板正文',
    proposedText: '进化后的模板正文',
    rationale: '窗口内注入知识仍高失败',
    evidence: { windowHours: 24, eventCounts: { outcomes: 8, failures: 6 } },
    status: 'pending',
    source: 'heuristic:prompt-failure',
    createdAt: new Date().toISOString(),
    ...patch,
  };
  await fileStore.createEvolutionProposal(p);
  return p;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-review-adapter-'));
  fileStore = new FileStore(tmpDir);
  prevEnv = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(tmpDir, 'prompt-overrides');
  paths = resolveEvolutionPaths({
    repoRoot: tmpDir,
    eventsDir: path.join(tmpDir, 'events'),
    studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
  });
  // 构造即注册 kind='evolution' adapter（绑定本实例的 fileStore/decide）
  service = new EvolutionService({ fileStore, paths, postCard: false });
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-sys', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
});

afterEach(() => {
  clearReviewProposalAdapters();
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('toReviewProposalStatus 读侧归一', () => {
  it('evolution 状态 → 正本词表（approved→pending 保留 APPLY_FAILED 重试通道）', () => {
    expect(toReviewProposalStatus('pending')).toBe('pending');
    expect(toReviewProposalStatus('approved')).toBe('pending');
    expect(toReviewProposalStatus('applied')).toBe('executed');
    expect(toReviewProposalStatus('rejected')).toBe('rejected');
    expect(toReviewProposalStatus('stale')).toBe('stale');
  });
});

describe('EvolutionProposalStore', () => {
  it('listProposals/getProposal 包 evolution FileStore 读写并归一状态', async () => {
    await seedProposal();
    await seedProposal({ targetId: 'tpl-b', status: 'applied', appliedAt: new Date().toISOString() });
    await seedProposal({ targetId: 'tpl-c', status: 'stale', staledAt: new Date().toISOString() });

    const store = new EvolutionProposalStore(fileStore);
    const all = await store.listProposals();
    expect(all.map(p => p.status)).toEqual(['pending', 'executed', 'stale']);

    const got = await store.getProposal('EP-0002');
    expect(got?.status).toBe('executed');
    expect(got?.targetId).toBe('tpl-b');
    expect(await store.getProposal('EP-9999')).toBeNull();
  });

  it('appendStatus 为 no-op（状态唯一写入点 = EvolutionService.decide）', async () => {
    const p = await seedProposal();
    const store = new EvolutionProposalStore(fileStore);
    await store.appendStatus(p.id, 'executed');
    expect((await fileStore.getEvolutionProposal(p.id))?.status).toBe('pending');
  });
});

describe('renderCardContent', () => {
  it('卡片正文含当前/提案/理由/证据窗口，cardData 带 proposalId 接线', async () => {
    const p = await seedProposal();
    const adapter = registerEvolutionReviewAdapter({ fileStore, service });
    const { content, cardData } = adapter.renderCardContent(p);
    expect(content).toContain(p.id);
    expect(content).toContain('prompt-template / tpl-review');
    expect(content).toContain('旧模板正文');
    expect(content).toContain('进化后的模板正文');
    expect(content).toContain('窗口内注入知识仍高失败');
    expect(content).toContain('窗口 24h');
    expect(cardData.proposalId).toBe(p.id);
    expect(cardData.targetType).toBe('prompt-template');
    expect(adapter.cardType).toBe('evolution_proposal');
    expect(adapter.author).toBe('Evolution');
  });
});

describe('runScan 发布路径', () => {
  it('新提案发 evolution_proposal 卡到 #系统（不再发文本消息）', async () => {
    const cardService = new EvolutionService({ fileStore, paths });
    // heuristic (b) fixture：6 失败（3 注入）+ 2 成功
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ success: false, consumedKnowledge: [`k${i}`] })),
      ...Array.from({ length: 3 }, () => ({ success: false, consumedKnowledge: [] })),
      ...Array.from({ length: 2 }, () => ({ success: true, consumedKnowledge: [] })),
    ].map(o => ({
      type: `knowledge:outcome:${o.success ? 'success' : 'failure'}`,
      payload: JSON.stringify(o),
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(paths.studioEventsFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const result = await cardService.runScan();
    expect(result.created.length).toBe(1);
    expect(result.posted).toBe(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, author, content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(author).toBe('Evolution');
    expect(cardType).toBe('evolution_proposal');
    expect(content).toContain(result.created[0].id);
    expect((cardData as { proposalId: string }).proposalId).toBe(result.created[0].id);
  });
});

describe('卡片审批端到端（正本端点 → EvolutionService.decide）', () => {
  it('approve → applied 生效（override 落盘），正本状态派生 executed', async () => {
    const p = await seedProposal();

    const result = await approveProposal('evolution', p.id);
    expect(result.kind).toBe('executed');

    // apply 已落盘
    const override = path.join(process.env.STUDIO_PROMPT_OVERRIDES_DIR as string, 'tpl-review.md');
    expect(fs.readFileSync(override, 'utf-8')).toBe('进化后的模板正文');

    // evolution 存储终态
    const decided = await service.get(p.id);
    expect(decided!.status).toBe('applied');
    expect(decided!.decidedBy).toBe('card');
    expect(decided!.appliedAt).toBeTruthy();

    // 正本读面归一 + 幂等闸：再 approve → not-pending
    expect((await getProposalStatus('evolution', p.id)).status).toBe('executed');
    const again = await approveProposal('evolution', p.id);
    expect(again).toEqual({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('reject → rejected（零副作用），再 approve 被闸', async () => {
    const p = await seedProposal();

    const result = await rejectProposal('evolution', p.id);
    expect(result.ok).toBe(true);

    const decided = await service.get(p.id);
    expect(decided!.status).toBe('rejected');
    expect(decided!.decidedBy).toBe('card');
    expect(fs.existsSync(path.join(tmpDir, 'prompt-overrides'))).toBe(false);

    const again = await approveProposal('evolution', p.id);
    expect(again).toEqual({ kind: 'invalid', error: 'proposal-not-pending:rejected' });
  });

  it('APPLY_FAILED：outcome=failed，提案停 approved，读侧归一 pending 可重试', async () => {
    // 存量历史词表提案（message 已出动作集）→ applier 抛「落点已退役」
    const p = await seedProposal({
      targetType: 'iron-law', targetId: 'no_redis_import',
      constraintChange: 'message' as unknown as EvolutionProposalData['constraintChange'],
    });

    const result = await approveProposal('evolution', p.id);
    expect(result.kind).toBe('failed');
    expect((result as { error?: string }).error).toContain('落点已退役');

    // decide 停在 approved（未落 applied）；appendStatus('failed') no-op 不覆盖
    const decided = await service.get(p.id);
    expect(decided!.status).toBe('approved');
    expect(decided!.appliedAt).toBeFalsy();
    // 读侧归一 pending → 修复后可再走 approve 重试（不被正本 not-pending 闸挡）
    expect((await getProposalStatus('evolution', p.id)).status).toBe('pending');
  });
});
