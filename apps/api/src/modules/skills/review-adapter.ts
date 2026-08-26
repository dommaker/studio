/**
 * review-adapter (#354) — skills 提案审批 adapter（接线 review-proposal 正本）
 *
 * ADR 2026-08-25 决策落地：
 * - 决策 2（业务方只做 adapter）：各拷贝间真正不同的只有「卡片内容」（renderSkillCard，
 *   extraction/distill 两种旧卡文案原样保留，cardData 形状不变 { proposalId, skillId }）
 *   与「审批后动作」（onApprove：skill→draft + 生成 SKILL.md，自 skill-extraction.reviewProposal
 *   原样搬入；reject 零副作用）；存取/发卡/approve/reject 生命周期全部归 review-proposal 正本。
 * - 决策 4（通用端点）：专有 /api/v1/skills/proposals/:id/{approve,reject} 端点随本接线删除，
 *   审批走 /api/v1/review-proposals/skill/:id/{approve,reject,status}。
 *
 * 存储：正本默认物化 <dataDir>/skill-proposals.jsonl（append-only + 状态墓碑折叠），
 * 词表 pending|executed|rejected|failed|card-failed。旧自持存储 ~/.studio/proposals.json
 * （JSON 数组形态，非 append-only）随 proposal-store.ts 一并退役——历史文件不改写不迁移，
 * 其中存量 pending 提案不再进入待审列表（新存储起算）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { FileStore, logger } from '@dommaker/studio-shared';
import { studioDir, studioPath } from '@dommaker/studio-shared/studio-dir';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/registry.js';
import { submitProposal } from '../review-proposal/service.js';
import type { ReviewProposalBase } from '../review-proposal/store.js';
import { skillStore } from './skill-store.js';

/** skill 提案载荷（行形态：{ kind:'proposal', ... } 落 skill-proposals.jsonl） */
export interface SkillReviewProposal extends ReviewProposalBase {
  skillId: string;
  name: string;
  description: string;
  category?: string;
  confidence?: number;
  /** extraction = sourceGoalIds；distill = 原料条目 id 清单 */
  sourceGoalIds?: string[];
  /** 'system'（skill-extraction 提取链路）| 'distill'（蒸馏落地） */
  proposedBy: string;
  summary?: string;
}

/**
 * 卡片渲染：两种旧卡文案原样保留（行为一致）。
 * extraction 卡：Category/Confidence/Source Goal 行；distill 卡：Source: 知识蒸馏 行。
 * cardData 形状不变 { proposalId, skillId }（CLI/前端零感知）。
 */
function renderSkillCard(p: SkillReviewProposal): { content: string; cardData: Record<string, unknown> } {
  const lines = [
    `Skill pending review: **${p.name}**`,
    `Description: ${p.description}`,
  ];
  if (p.category) lines.push(`Category: ${p.category}`);
  if (typeof p.confidence === 'number') lines.push(`Confidence: ${(p.confidence * 100).toFixed(0)}%`);
  if (p.proposedBy === 'distill') {
    lines.push(`Source: 知识蒸馏（原料 ${p.sourceGoalIds?.length ?? 0} 条）`);
  } else if (p.sourceGoalIds?.length) {
    lines.push(`Source Goal: ${p.sourceGoalIds.join(', ')}`);
  }
  return { content: lines.join('\n'), cardData: { proposalId: p.id, skillId: p.skillId } };
}

/**
 * approve 后动作（自 skill-extraction.reviewProposal 的 approved 分支原样搬入）：
 * skill→draft + 生成 SKILL.md（已存在则跳过；生成失败非阻断，仅 warn）。
 */
async function executeSkillApproval(p: SkillReviewProposal): Promise<ApproveOutcome> {
  const skill = skillStore.get(p.skillId);
  skillStore.update(p.skillId, { status: 'draft' });

  try {
    const skillName = skill?.name || p.skillId;
    const metadata = skill?.metadata ? JSON.parse(skill.metadata) : {};
    const skillsRoot = process.env.SKILLS_DIR || studioPath('skills');
    const skillDir = path.join(skillsRoot, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      logger.info('[SkillReview] SKILL.md already exists, skipping', { skillName, path: skillFile });
    } else {
      fs.mkdirSync(skillDir, { recursive: true });
      const pattern = metadata.pattern || `Skill: ${skillName}\n\nTBD -- manual refinement needed.`;
      const frontmatter = [
        '---',
        `name: '${skillName}'`,
        'version: 1',
        `agentTypes: ['executor']`,
        `status: 'draft'`,
        '---',
      ].join('\n');
      fs.writeFileSync(skillFile, `${frontmatter}\n\n${pattern}`, 'utf-8');
      logger.info('[SkillReview] SKILL.md generated', { skillName, path: skillDir });
    }
  } catch (e) {
    logger.warn('[SkillReview] SKILL.md generation failed (non-blocking)', { error: String(e) });
  }
  return { status: 'executed' };
}

/**
 * 注册 skill adapter（kind='skill'）。同 kind 重复注册后者生效（幂等）。
 * 运行时装配无显式入口——取用处经 getSkillReviewAdapter 自助注册（同 #353 role-memory 口径）。
 */
export function registerSkillReviewAdapter(deps?: {
  fileStore?: FileStore;
  dataDir?: string;
}): ReviewProposalAdapter<SkillReviewProposal> {
  const fileStore = deps?.fileStore ?? new FileStore();
  return registerReviewProposalAdapter<SkillReviewProposal>({
    kind: 'skill',
    cardType: 'skill_review_request',
    storeNamespace: 'skill-proposals',
    dataDir: deps?.dataDir ?? studioDir(),
    fileStore,
    renderCardContent: renderSkillCard,
    onApprove: executeSkillApproval,
    // reject 零业务副作用（墓碑由正本落）——同旧 reviewProposal 的 rejected 分支
  });
}

/** 取 skill adapter（未注册则自助注册，幂等） */
export function getSkillReviewAdapter(): ReviewProposalAdapter<SkillReviewProposal> {
  return getReviewProposalAdapter<SkillReviewProposal>('skill') ?? registerSkillReviewAdapter();
}

/**
 * 建提案 + 发卡（正本 submitProposal：append-only 落 pending → 发卡 → 失败落 card-failed 墓碑）。
 * 返回 proposalId 与发卡结果；发卡失败不抛（#101/#143 降级口径，业务链路不被通知阻断）。
 */
export async function submitSkillProposal(
  input: Omit<SkillReviewProposal, 'id' | 'createdAt'>,
): Promise<{ proposalId: string; posted: boolean }> {
  const adapter = getSkillReviewAdapter();
  const proposal: SkillReviewProposal = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const { posted } = await submitProposal(adapter, proposal);
  return { proposalId: proposal.id, posted };
}
