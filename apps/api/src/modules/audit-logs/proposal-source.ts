/**
 * audit-logs/proposal-source (#591 A 类) — review-proposal 正本的聚合读面
 *
 * 依据 docs/adr/2026-09-17-decision-audit-consolidation.md 决策 2：经人审决策
 * （distill/gc/memory/skill/knowledge/auditor/evolution 7 种 kind 的提案存储）
 * 不加新写入点，聚合读并进 audit-logs 查询轨（source=proposal 维度）。
 * 折叠归各 adapter 的 store 正本（append-only + 墓碑折叠，含 memory per-role
 * draft.jsonl 与 evolution EP-XXXX.json 单提案文件两个形态例外）；单 kind 读取
 * 失败跳过该 kind，不拖垮整列。
 *
 * 行形状对齐 audit-logs：actorType='agent'、action='propose'、resource=kind、
 * resourceId=提案 id、status=提案终态原值（pending/executed/rejected/failed/card-failed，
 * evolution 另有 stale——超期未审惰性终态，读侧归一保留原值）。
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
  /** 提案 kind（distill/gc/memory/skill/knowledge/auditor） */
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

function toRow(
  kind: string,
  author: string,
  p: ReviewProposalRecord<ReviewProposalBase>,
  full = false,
): ProposalDecisionRow {
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
      author,
      statusAt: p.statusAt,
      ...(typeof summary === 'string' ? { summary } : {}),
      // 详情端点（full）带提案全文；列表保持薄行（摘要粒度）
      ...(full ? { proposal: p } : {}),
    }),
  };
}

/**
 * 自助注册兜底：skill/knowledge/auditor/memory/evolution 五域有自助注册入口；
 * distill/gc 由运行时装配（DistillService 构造）注册——未装配时按已知 kind 词表
 * warn 留痕（不静默缺源），读面跳过该 kind。
 * （audit kind 已随 #617/#620 拆除：adapter 删除 + 读取面清除，词表同步移除。
 *  evolution 随 #623 归位正本卡片：自定义 store 包 evolution FileStore 读写。）
 */
const KNOWN_KINDS = ['distill', 'gc', 'memory', 'skill', 'knowledge', 'auditor', 'evolution'] as const;

async function ensureAdaptersRegistered(): Promise<void> {
  const [skills, knowledge, auditor, memory, evolution] = await Promise.all([
    import('../skills/review-adapter.js'),
    import('../knowledge/review-adapter.js'),
    import('../agents/auditor/review-adapter.js'),
    import('../role-memory/review-adapter.js'),
    import('../evolution/review-adapter.js'),
  ]);
  skills.getSkillReviewAdapter();
  knowledge.getKnowledgeReviewAdapter();
  auditor.getAuditorReviewAdapter();
  if (!getReviewProposalAdapter('memory')) memory.registerMemoryReviewAdapter();
  if (!getReviewProposalAdapter('evolution')) {
    const { getEvolutionService } = await import('../evolution/evolution.service.js');
    const svc = getEvolutionService();
    evolution.registerEvolutionReviewAdapter({ fileStore: svc.store, service: svc });
  }
  const missing = KNOWN_KINDS.filter(k => !getReviewProposalAdapter(k));
  if (missing.length > 0) {
    logger.warn({ missing }, '[audit-logs] proposal source: kinds not registered (skipped)');
  }
}

/** 遍历当前注册表聚合全部 kind 的提案行（不触发注册，测试/内部用）；full=true 时 details 带提案全文 */
export async function collectProposalDecisionRows(opts?: { full?: boolean }): Promise<ProposalDecisionRow[]> {
  const rows: ProposalDecisionRow[] = [];
  for (const adapter of listReviewProposalAdapters()) {
    try {
      for (const p of await adapter.store.listProposals()) {
        rows.push(toRow(adapter.kind, adapter.author ?? 'KK', p, opts?.full));
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

/** 按 id 回查提案行（GET /:id 兜底用）；details 带提案全文（详情语义） */
export async function getProposalDecisionRowById(id: string): Promise<ProposalDecisionRow | null> {
  await ensureAdaptersRegistered();
  return (await collectProposalDecisionRows({ full: true })).find(r => r.id === id) ?? null;
}
