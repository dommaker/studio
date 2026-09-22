/**
 * distill-landings (#145) — 蒸馏产物分类落地的两个通道实现（运行时装配见 distill-runtime）。
 *
 *   - skill（过程性知识）→ skills 库提案：skillStore draft + review-proposal 正本提案
 *     （#354：submitSkillProposal，kind='skill'；skill_review_request 人审卡由正本投放，
 *     审批走通用端点 /api/v1/review-proposals/skill/:id/*）
 *   - preference / execution-knowledge → 角色记忆草稿（studio 系统角色，review=manual）+
 *     memory_proposal 人审卡（#353：经 review-proposal 正本 submitMemoryProposal）
 *
 * constraint 通道已随 #625 整体拆除（#622 裁决：落点为死端，生命周期归 evolution 飞轮）。
 * 两类产物都带 sourceReferences 原料指针（skill→metadata、memory→sourceRefs）。
 * 通道返回落地产物 id；返回 null / 抛错 → DistillService 回落知识条目（产物不丢）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger, type FileStore } from '@dommaker/studio-shared';
import { skillStore } from '../skills/skill-store.js';
import { submitSkillProposal } from '../skills/review-adapter.js';
import { type MemoryKind } from '../role-memory/role-memory.js';
import { submitMemoryProposal } from '../role-memory/review-adapter.js';
import { ensureStudioProfile } from '../agents/agent-profile.service.js';
import type { DistillLanding } from './distill-service.js';

/** companies 目录取第一家可用公司 id（skill 记录必填 companyId；无公司 → null，调用方回落）。
 *  TODO(#145 后续)：多公司环境下「第一家」语义粗糙，公司归属解析待显式化（蒸馏无公司上下文）。 */
function firstCompanyId(companiesDir: string): string | null {
  try {
    const file = fs.readdirSync(companiesDir).filter(f => f.endsWith('.json')).sort()[0];
    if (!file) return null;
    const parsed = JSON.parse(fs.readFileSync(path.join(companiesDir, file), 'utf-8')) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * skill 通道：蒸馏产物 → skills 库提案（draft skill + 正本 pending 提案 + 人审卡）。
 * #354：提案存取/发卡归 review-proposal 正本（submitSkillProposal，kind='skill'）；
 * 蒸馏产物一律走人工审批（无置信度自动发布）。发卡失败由正本落 card-failed 墓碑，不抛。
 */
export function createSkillLanding(opts: { fileStore: FileStore; companiesDir: string }): DistillLanding {
  return async (product, ctx) => {
    const companyId = firstCompanyId(opts.companiesDir);
    if (!companyId) {
      logger.warn('[Distill] skill landing skipped: no company available', { title: product.title });
      return null;
    }

    const skill = skillStore.create({
      companyId,
      name: product.title,
      description: product.content,
      source: 'distill',
      status: 'draft',
      metadata: JSON.stringify({
        tags: product.tags,
        sourceReferences: ctx.materialIds,
        distillProposalId: ctx.proposalId,
        distillRunId: ctx.runId,
      }),
    });
    const { proposalId } = await submitSkillProposal({
      skillId: skill.id,
      name: product.title,
      description: product.content,
      sourceGoalIds: ctx.materialIds,
      proposedBy: 'distill',
      summary: `蒸馏产物待审：${product.title}`,
    });

    return proposalId;
  };
}

/**
 * memory 通道：preference / execution-knowledge 产物 → studio 系统角色记忆草稿（review=manual）
 * + memory_proposal 人审卡（#353：经 review-proposal 正本 submitMemoryProposal）。roleId = studio
 * 系统角色（ensureStudioProfile 幂等解析）——蒸馏是系统级沉淀，锚在系统角色记忆。
 */
export function createMemoryLanding(opts: { fileStore: FileStore }): DistillLanding {
  return async (product, ctx) => {
    const kind: MemoryKind = product.type === 'preference' ? 'preference' : 'execution-knowledge';
    const profile = await ensureStudioProfile(opts.fileStore);
    const entries = await submitMemoryProposal(profile.id, [{
      kind,
      title: product.title,
      content: product.content,
      review: 'manual',
      sourceRefs: ctx.materialIds,
    }], { source: 'distill' });
    return entries[0]?.id ?? null;
  };
}
