/**
 * distill-landings (#145) — 蒸馏产物三分落地的三个通道实现（运行时装配见 distill-runtime）。
 *
 *   - skill（过程性知识）→ skills 库提案：skillStore draft + review-proposal 正本提案
 *     （#354：submitSkillProposal，kind='skill'；skill_review_request 人审卡由正本投放，
 *     审批走通用端点 /api/v1/review-proposals/skill/:id/*）
 *   - constraint（边界性知识）→ custom-constraints.yml 变更草案落盘（constraint-drafts.jsonl，
 *     add/override/retire 的具体 diff，不直接改约束文件）——#82 D6 派单通道未就绪的简化形态，
 *     派单接线后补（草案 status=pending 等派单）
 *   - preference / execution-knowledge → 角色记忆草稿（studio 系统角色，review=manual）+
 *     memory_proposal 人审卡（#353：经 review-proposal 正本 submitMemoryProposal）
 *
 * 三类产物都带 sourceReferences 原料指针（skill→metadata、constraint→草案记录、memory→sourceRefs）。
 * 通道返回落地产物 id；返回 null / 抛错 → DistillService 回落知识条目（产物不丢）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
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

/** 约束变更草案记录（constraint-drafts.jsonl 一行；D6 派单接线前只有 pending 形态） */
export interface ConstraintDraftRecord {
  id: string;
  createdAt: string;
  /** pending = 待派单（#82 D6 通道就绪后由派单流程消费） */
  status: 'pending';
  action: 'add' | 'override' | 'retire';
  constraintId: string;
  /** yml 变更草案片段：add/override 为 custom_constraints 条目 YAML；retire 为退役说明 */
  ymlSnippet: string;
  title: string;
  rationale: string;
  /** sourceReferences 原料指针（原料知识条目 id 清单） */
  sourceReferences: string[];
  distillProposalId: string;
  distillRunId: string;
}

/** 变更草案片段渲染：add/override → custom_constraints 条目 YAML；retire → config.yml 退役 YAML（harness retire 落点） */
function renderConstraintSnippet(product: { change?: { action: string; constraintId: string; level?: string; message?: string; description?: string }; content: string }): string {
  const change = product.change!;
  if (change.action === 'retire') {
    // retire 的 harness 落点是 .harness/config.yml（constraints.<id>.enabled=false + retired 墓碑），
    // 非 custom-constraints.yml——草案照实给出 config.yml diff，等价于 harness constraints retire <id>
    const snippet = yaml.dump(
      { constraints: { [change.constraintId]: { enabled: false, retired: { reason: product.content } } } },
      { lineWidth: 120 },
    );
    return `# retire 草案：${change.constraintId}（落点 .harness/config.yml；等价 harness constraints retire ${change.constraintId}）\n${snippet}`;
  }
  const entry: Record<string, string> = {};
  if (change.level) entry.level = change.level;
  if (change.message) entry.message = change.message;
  if (change.description) entry.description = change.description;
  return yaml.dump({ custom_constraints: { [change.constraintId]: entry } }, { lineWidth: 120 });
}

/**
 * constraint 通道：约束类产物 → 变更草案落盘（不直接改约束文件）。
 * #82 D6 半自动补丁派单通道未就绪 → 简化落盘形态，草案 status=pending 待派单接线消费。
 */
export function createConstraintLanding(opts: { fileStore: FileStore; dataDir: string }): DistillLanding {
  return async (product, ctx) => {
    const change = product.change!; // normalize 保证 constraint 产物必带合法 change
    const record: ConstraintDraftRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      action: change.action,
      constraintId: change.constraintId,
      ymlSnippet: renderConstraintSnippet(product),
      title: product.title,
      rationale: product.content,
      sourceReferences: ctx.materialIds,
      distillProposalId: ctx.proposalId,
      distillRunId: ctx.runId,
    };
    await opts.fileStore.appendJsonl(path.join(opts.dataDir, 'constraint-drafts.jsonl'), record);
    return record.id;
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
