/**
 * review-adapter (#354) — skills 提案审批接线 review-proposal 正本的行为级测试
 *
 * 契约（ADR 2026-08-25 决策 2/4）：
 *   - 提案存取/发卡/approve/reject/status 全归 review-proposal 正本（kind='skill'）；
 *     存储物化 <dataDir>/skill-proposals.jsonl（append-only），词表 pending|executed|rejected|failed|card-failed。
 *   - 业务方只保留「卡片内容」（renderSkillCard：extraction/distill 两种旧卡文案原样保留，
 *     cardData 形状不变 { proposalId, skillId }）与「审批后动作」（onApprove：skill→draft +
 *     生成 SKILL.md；reject 零副作用）。
 *   - 发卡失败落 card-failed 墓碑不抛（#101/#143 降级口径）。
 *
 * 新旧覆盖对照（删旧测前的映射，过 no_test_simplification 闸）：
 *   - skill-md-generation.test「approved proposal generates SKILL.md…/file already exists→skip/
 *     updates proposal and skill status」→ 本文件「approve 全链路」「SKILL.md 已存在」「重复 approve」
 *   - proposal-store.test（CRUD 单测）→ 正本 store 行为由 review-proposal/__tests__/store.test.ts 兜底，
 *     skills 侧不再有自持存储可测
 *   - distill-landings.test「skill_review_request 卡」断言 → 本文件「submit 发卡」用例
 *     （distill 侧改为断言 submitSkillProposal 入参）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCreateCardMessage, mockSkillGet, mockSkillUpdate } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn().mockResolvedValue({}),
  mockSkillGet: vi.fn(),
  mockSkillUpdate: vi.fn(),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

// skillStore 单例固定写 ~/.studio——mock 掉以隔离真实数据区
vi.mock('../skill-store.js', () => ({
  skillStore: { get: mockSkillGet, update: mockSkillUpdate },
}));

import { FileStore } from '@dommaker/studio-shared';
import { clearReviewProposalAdapters } from '../../review-proposal/registry.js';
import { approveProposal, rejectProposal, getProposalStatus } from '../../review-proposal/service.js';
import { registerSkillReviewAdapter, submitSkillProposal } from '../review-adapter.js';

let tmpRoot: string;
let dataDir: string;
let skillsDir: string;
let fileStore: FileStore;
let listChannelsSpy: ReturnType<typeof vi.spyOn>;
let prevSkillsDir: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  clearReviewProposalAdapters();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-review-adapter-'));
  dataDir = path.join(tmpRoot, 'data');
  skillsDir = path.join(tmpRoot, 'skills');
  prevSkillsDir = process.env.SKILLS_DIR;
  process.env.SKILLS_DIR = skillsDir;
  fileStore = new FileStore();
  // 发卡频道解析走 adapter.fileStore.listChannels——spy 控制 #系统 频道有无，其余 FileStore I/O 全真
  listChannelsSpy = vi.spyOn(fileStore, 'listChannels').mockResolvedValue([]);
  registerSkillReviewAdapter({ fileStore, dataDir });
});

afterEach(() => {
  if (prevSkillsDir === undefined) delete process.env.SKILLS_DIR;
  else process.env.SKILLS_DIR = prevSkillsDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('submitSkillProposal — 建提案 + 发卡（行为同旧 skill_review_request 卡）', () => {
  it('extraction 形态：提案落 pending + 卡片文案含 Category/Confidence/Source Goal，cardData 形状不变', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);

    const { proposalId, posted } = await submitSkillProposal({
      skillId: 'skill-1',
      name: 'ci-fix',
      description: '修 CI 的套路',
      category: 'testing',
      confidence: 0.7,
      sourceGoalIds: ['g1', 'g2'],
      proposedBy: 'system',
      summary: 'Pending review (confidence: 0.70 < 0.8)',
    });

    expect(posted).toBe(true);
    expect((await getProposalStatus('skill', proposalId))).toMatchObject({ ok: true, status: 'pending' });

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(cardType).toBe('skill_review_request');
    expect(content).toContain('Skill pending review: **ci-fix**');
    expect(content).toContain('Description: 修 CI 的套路');
    expect(content).toContain('Category: testing');
    expect(content).toContain('Confidence: 70%');
    expect(content).toContain('Source Goal: g1, g2');
    expect(cardData).toEqual({ proposalId, skillId: 'skill-1' });
  });

  it('distill 形态：proposedBy=distill → Source: 知识蒸馏 行，无 Category/Confidence 行', async () => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);

    const { proposalId } = await submitSkillProposal({
      skillId: 'skill-2',
      name: '迁移执行法',
      description: 'Round 分解 → 转换 → 验证',
      sourceGoalIds: ['m1', 'm2', 'm3'],
      proposedBy: 'distill',
      summary: '蒸馏产物待审：迁移执行法',
    });

    const [, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(cardType).toBe('skill_review_request');
    expect(content).toContain('Skill pending review: **迁移执行法**');
    expect(content).toContain('Description: Round 分解 → 转换 → 验证');
    expect(content).toContain('Source: 知识蒸馏（原料 3 条）');
    expect(content).not.toContain('Category:');
    expect(content).not.toContain('Confidence:');
    expect(content).not.toContain('Source Goal:');
    expect(cardData).toEqual({ proposalId, skillId: 'skill-2' });
  });

  it('#系统 频道缺失 → posted=false，落 card-failed 墓碑不抛（提取链路不被通知阻断）', async () => {
    listChannelsSpy.mockResolvedValue([]);

    const { proposalId, posted } = await submitSkillProposal({
      skillId: 'skill-3', name: 'no-channel', description: 'd', proposedBy: 'system',
    });

    expect(posted).toBe(false);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect((await getProposalStatus('skill', proposalId))).toMatchObject({ ok: true, status: 'card-failed' });
  });
});

describe('正本生命周期全链路（kind=skill，通用端点同款 service 驱动）', () => {
  beforeEach(() => {
    listChannelsSpy.mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
    mockSkillGet.mockReturnValue({
      id: 'skill-1',
      name: 'ci-fix',
      metadata: JSON.stringify({ pattern: 'Fix the CI issue by...' }),
    });
  });

  it('建提案 → approve → executed + skill→draft + SKILL.md 落盘（frontmatter 无 trigger，含 pattern）', async () => {
    const { proposalId } = await submitSkillProposal({
      skillId: 'skill-1', name: 'ci-fix', description: 'd', category: 'testing',
      confidence: 0.7, sourceGoalIds: ['g1'], proposedBy: 'system',
    });

    const approved = await approveProposal('skill', proposalId);
    expect(approved).toMatchObject({ kind: 'executed' });

    expect((await getProposalStatus('skill', proposalId))).toMatchObject({ ok: true, status: 'executed' });
    expect(mockSkillUpdate).toHaveBeenCalledWith('skill-1', { status: 'draft' });

    const skillFile = path.join(skillsDir, 'ci-fix', 'SKILL.md');
    expect(fs.existsSync(skillFile)).toBe(true);
    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain("name: 'ci-fix'");
    expect(content).toContain('version: 1');
    expect(content).toContain("status: 'draft'");
    expect(content).not.toContain('trigger:');
    expect(content).toContain('Fix the CI issue by...');

    // 重复 approve → not-pending 闸（正本词表）
    const again = await approveProposal('skill', proposalId);
    expect(again).toMatchObject({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('SKILL.md 已存在 → 跳过写盘，仍 executed（同旧 reviewProposal 行为）', async () => {
    fs.mkdirSync(path.join(skillsDir, 'ci-fix'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'ci-fix', 'SKILL.md'), 'existing', 'utf-8');

    const { proposalId } = await submitSkillProposal({
      skillId: 'skill-1', name: 'ci-fix', description: 'd', proposedBy: 'system',
    });
    const approved = await approveProposal('skill', proposalId);

    expect(approved).toMatchObject({ kind: 'executed' });
    expect(fs.readFileSync(path.join(skillsDir, 'ci-fix', 'SKILL.md'), 'utf-8')).toBe('existing');
  });

  it('reject → rejected 墓碑，零副作用（不写 SKILL.md、不动 skill）', async () => {
    const { proposalId } = await submitSkillProposal({
      skillId: 'skill-1', name: 'ci-fix', description: 'd', proposedBy: 'system',
    });

    expect(await rejectProposal('skill', proposalId)).toEqual({ ok: true });
    expect((await getProposalStatus('skill', proposalId))).toMatchObject({ ok: true, status: 'rejected' });
    expect(fs.existsSync(path.join(skillsDir, 'ci-fix'))).toBe(false);
    expect(mockSkillUpdate).not.toHaveBeenCalled();

    const again = await rejectProposal('skill', proposalId);
    expect(again).toMatchObject({ ok: false, error: 'proposal-not-pending:rejected' });
  });

  it('查无提案 → proposal-not-found；status → unknown', async () => {
    expect(await approveProposal('skill', 'ghost')).toMatchObject({ kind: 'invalid', error: 'proposal-not-found' });
    expect((await getProposalStatus('skill', 'ghost'))).toMatchObject({ ok: true, status: 'unknown' });
  });
});
