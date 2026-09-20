/**
 * audit-logs/proposal-source (#591 A 类) — review-proposal 正本的聚合读面
 *
 * 依据 docs/adr/2026-09-17-decision-audit-consolidation.md 决策 2：经人审决策
 * （distill/gc/audit/memory/skill/knowledge/auditor 7 种 kind 的 *-proposals.jsonl）
 * 不加新写入点，聚合读并进 audit-logs 查询轨（source=proposal 维度）。
 * 折叠归各 adapter 的 store 正本（append-only + 墓碑折叠，含 memory per-role
 * draft.jsonl 形态例外）；单 kind 读取失败跳过该 kind，不拖垮整列。
 *
 * 行形状对齐 audit-logs：actorType='agent'、action='propose'、resource=kind、
 * resourceId=提案 id、status=提案终态原值（pending/executed/rejected/failed/card-failed）。
 */
import { logger } from '../../utils/logger.js';
import {
  getReviewProposalAdapter,
  listReviewProposalAdapters,
} from '../review-proposal/registry.js';
import type {
  ReviewProposalBase,
  ReviewProposalRecord,
} from '../review-proposal/store.js';

/** 聚合读面行（与 AuditService 的 AuditLogRow 子集同形） */
export interface ProposalDecisionRow {
  id: string;
  actorType: 'agent';
  action: 'propose';
  /** 提案 kind（distill/gc/audit/memory/skill/knowledge/auditor） */
  resource: string;
  resourceId: string;
  /** 提案终态原值（pending/executed/rejected/failed/card-failed） */
  status: string;
  createdAt: string;
  details: string | null;
}

/** 提案行可过滤的维度（与 AuditLogQuery 对齐的子集） */
export interface ProposalDecisionFilter {
  action?: string;
  resource?: string;
  resourceId?: string;
  status?: string;
  actorType?: 'human' | 'agent';
  userId?: string;
  roleId?: string;
  companyId?: string;
  anonymousId?: string;
  startTime?: Date;
  endTime?: Date;
}

function toRow(kind: string, p: ReviewProposalRecord<ReviewProposalBase>): ProposalDecisionRow {
  const summary = (p as unknown as Record<string, unknown>).title ?? (p as unknown as Record<string, unknown>).name;
  return {
    id: p.id,
    actorType: 'agent',
    action: 'propose',
    resource: kind,
    resourceId: p.id,
    status: p.status,
    createdAt: p.createdAt,
    details: JSON.stringify({
      statusAt: p.statusAt,
      ...(typeof summary === 'string' ? { summary } : {}),
    }),
  };
}

/**
 * 自助注册兜底：skill/knowledge/auditor/memory 四域有自助注册入口；
 * distill/gc/audit 由运行时装配（DistillService 构造）注册，未装配则跳过该 kind。
 */
async function ensureAdaptersRegistered(): Promise<void> {
  const [skills, knowledge, auditor, memory] = await Promise.all([
    import('../skills/review-adapter.js'),
    import('../knowledge/review-adapter.js'),
    import('../agents/auditor/review-adapter.js'),
    import('../role-memory/review-adapter.js'),
  ]);
  skills.getSkillReviewAdapter();
  knowledge.getKnowledgeReviewAdapter();
  auditor.getAuditorReviewAdapter();
  if (!getReviewProposalAdapter('memory')) memory.registerMemoryReviewAdapter();
}

/** 遍历当前注册表聚合全部 kind 的提案行（不触发注册，测试/内部用） */
export async function collectProposalDecisionRows(): Promise<ProposalDecisionRow[]> {
  const rows: ProposalDecisionRow[] = [];
  for (const adapter of listReviewProposalAdapters()) {
    try {
      for (const p of await adapter.store.listProposals()) {
        rows.push(toRow(adapter.kind, p));
      }
    } catch (err) {
      logger.warn({ err, kind: adapter.kind }, '[audit-logs] proposal source kind read failed (skipped)');
    }
  }
  return rows;
}

/** 对提案行应用查询过滤（口径与 AuditService.query 对齐） */
export function filterProposalDecisionRows(
  rows: readonly ProposalDecisionRow[],
  q: ProposalDecisionFilter,
): ProposalDecisionRow[] {
  // 提案行无人的维度——按人过滤时整源出局
  if (q.userId || q.roleId || q.companyId || q.anonymousId) return [];
  // 提案行恒 actorType=agent
  if (q.actorType && q.actorType !== 'agent') return [];

  let out = rows;
  if (q.action) out = out.filter(r => r.action === q.action);
  if (q.resource) out = out.filter(r => r.resource === q.resource);
  if (q.resourceId) out = out.filter(r => r.resourceId === q.resourceId);
  if (q.status) out = out.filter(r => r.status === q.status);
  if (q.startTime || q.endTime) {
    out = out.filter(r => {
      const t = new Date(r.createdAt).getTime();
      if (q.startTime && t < q.startTime.getTime()) return false;
      if (q.endTime && t > q.endTime.getTime()) return false;
      return true;
    });
  }
  return [...out];
}

/** 路由侧入口：确保注册 → 聚合 → 过滤 */
export async function queryProposalDecisionRows(
  q: ProposalDecisionFilter,
): Promise<ProposalDecisionRow[]> {
  await ensureAdaptersRegistered();
  return filterProposalDecisionRows(await collectProposalDecisionRows(), q);
}

/** 按 id 回查提案行（GET /:id 兜底用） */
export async function getProposalDecisionRowById(id: string): Promise<ProposalDecisionRow | null> {
  await ensureAdaptersRegistered();
  return (await collectProposalDecisionRows()).find(r => r.id === id) ?? null;
}
