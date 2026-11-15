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
 * 通道返回落地产物 id 与 durable 状态；null 才回落知识条目，异常/card-failed 留待恢复。
 */
import path from 'node:path';
import { type FileStore } from '@dommaker/studio-shared';
import { skillStore } from '../skills/index.js';
import { submitSkillProposal, repostSkillProposal, getSkillReviewAdapter } from '../skills/index.js';
import { type MemoryKind } from '../role-memory/index.js';
import { registerMemoryReviewAdapter, submitMemoryProposal, repostMemoryProposal } from '../role-memory/index.js';
import { ensureStudioProfile } from '../agents/index.js';
import type { DistillLanding } from './distill-service.js';
import { logger } from '@dommaker/studio-shared/node';

/** companies 目录取第一家可用公司 id（skill 记录必填 companyId；无公司 → null，调用方回落）。
 *  P2-e：目录清单/读取走 FileStore seam（readdir + readJson），替代裸 fs 直读数据区。
 *  TODO(#145 后续)：多公司环境下「第一家」语义粗糙，公司归属解析待显式化（蒸馏无公司上下文）。 */
async function firstCompanyId(fileStore: FileStore, companiesDir: string): Promise<string | null> {
  try {
    const entries = await fileStore.readdir(companiesDir);
    const file = entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name).sort()[0];
    if (!file) return null;
    const parsed = await fileStore.readJson<{ id?: unknown }>(path.join(companiesDir, file));
    return parsed && typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
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
    let adoptedSkill: { id: string } | undefined;
    if (ctx.recovery) {
      const adapter = getSkillReviewAdapter();
      let proposal = ctx.landingId ? await adapter.store.getProposal(ctx.landingId) : null;
      if (!proposal && !ctx.landingId) {
        adoptedSkill = skillStore.list({ source: 'distill' }).find(skill => {
          try {
            return JSON.parse(skill.metadata ?? '{}').distillProductId === ctx.productId;
          } catch {
            return false;
          }
        });
        if (adoptedSkill) {
          proposal = (await adapter.store.listProposals()).find(item => item.skillId === adoptedSkill!.id) ?? null;
        }
      }
      if (ctx.landingId && !proposal) return { id: ctx.landingId, durable: false };
      if (proposal) {
        if (proposal.status === 'executed') return { id: proposal.id, durable: true };
        if (!['pending', 'card-failed'].includes(proposal.status)) return { id: proposal.id, durable: false };
        const { posted } = await repostSkillProposal(proposal.id);
        return { id: proposal.id, durable: posted };
      }
      if (adoptedSkill) {
        // 崩溃发生在 draft 已落盘、proposal 尚未落盘之前：只补提案，不重建 draft。
        const { proposalId, posted } = await submitSkillProposal({
          skillId: adoptedSkill.id,
          name: product.title,
          description: product.content,
          sourceGoalIds: ctx.materialIds,
          proposedBy: 'distill',
          summary: `蒸馏产物待审：${product.title}`,
        });
        return { id: proposalId, durable: posted };
      }
    }

    const companyId = await firstCompanyId(opts.fileStore, opts.companiesDir);
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
        distillProductId: ctx.productId,
      }),
    });
    const { proposalId, posted } = await submitSkillProposal({
      skillId: skill.id,
      name: product.title,
      description: product.content,
      sourceGoalIds: ctx.materialIds,
      proposedBy: 'distill',
      summary: `蒸馏产物待审：${product.title}`,
    });

    return { id: proposalId, durable: posted };
  };
}

/**
 * memory 通道：preference / execution-knowledge 产物 → studio 系统角色记忆草稿（review=manual）
 * + memory_proposal 人审卡（#353：经 review-proposal 正本 submitMemoryProposal）。roleId = studio
 * 系统角色（ensureStudioProfile 幂等解析）——蒸馏是系统级沉淀，锚在系统角色记忆。
 */
export function createMemoryLanding(opts: { fileStore: FileStore }): DistillLanding {
  return async (product, ctx) => {
    const adapter = registerMemoryReviewAdapter({ fileStore: opts.fileStore });
    if (ctx.recovery) {
      const landingId = ctx.landingId ?? ctx.productId;
      const existing = await adapter.store.getProposal(landingId);
      if (!existing) {
        if (ctx.landingId) return { id: ctx.landingId, durable: false };
      } else {
        if (existing.status === 'executed' || existing.status === 'pending') return { id: landingId, durable: true };
        if (existing.status === 'card-failed') {
          const { posted } = await repostMemoryProposal([existing], { source: 'distill' });
          return { id: landingId, durable: posted };
        }
        return { id: landingId, durable: false };
      }
    }

    const kind: MemoryKind = product.type === 'preference' ? 'preference' : 'execution-knowledge';
    const profile = await ensureStudioProfile(opts.fileStore);
    const entries = await submitMemoryProposal(profile.id, [{
      id: ctx.productId,
      kind,
      title: product.title,
      content: product.content,
      review: 'manual',
      sourceRefs: ctx.materialIds,
    }], { source: 'distill' });
    const entry = entries[0];
    if (!entry) return null;
    const persisted = await adapter.store.getProposal(entry.id);
    return { id: entry.id, durable: persisted !== null && persisted.status !== 'card-failed' };
  };
}
