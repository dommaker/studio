/**
 * distill-service (#143) — 蒸馏主链路最小闭环（#83 D1/D2/D5 落地，spec #141）
 *
 * 链路：WU 收尾钩子（workunit.status_changed → done）顺带跑门槛检测（distill-threshold
 * 纯函数，零 LLM 成本）→ 命中则发 distill_proposal 人审卡到 #系统 频道（原料清单+预期产出）
 * → approve 后由 system-executor 执行一次蒸馏调用 → 产出入库为知识条目（sourceReferences
 * 指向全部原料 id），原料矿石 maturity=archived 移出主区 → 运行记录落数据区（distill-store），
 * 全链路事件写 studio-events.jsonl（type=knowledge:distill）。
 *
 * 降级口径：
 *   - reject 零副作用（原料不动、无产物、无运行记录）
 *   - LLM 失败 / JSON 解析失败 → 原料不消费、WU 收尾不阻塞（失败也落运行记录触发 7 天熔断）
 *   - daily-token-budget 守卫照挂（预算耗尽 → 跳过执行，提案保持 pending 可次日重试）
 *   - 发卡失败静默跳过（提案标记 card-failed，不阻塞后续提案）
 *   - 已有 pending 提案 → 不重复发卡（人去频道处理即可）
 *
 * 事件订阅语义与 WuCompletionExtractor / AnalysisHandoff 一致（eventBus 进程内 best-effort，
 * fire-and-forget，绝不阻塞 WU 收尾）。
 *
 * #144 GC 候选清单：每次蒸馏运行落盘后 runGcCheck 按蒸馏周期计龄（gc-candidates 纯函数，
 * 不读墙钟）生成候选清单发 gc_proposal 人审卡；approveGc 候选 maturity=archived（可恢复），
 * rejectGc 零副作用且人判保留条目后续不再提案。零候选不发卡。
 *
 * #145 三分落地：蒸馏 LLM 产出自带类型分类——skill（过程性知识）→ skills 库提案；
 * constraint（边界性知识）→ constraint-drafts.jsonl 变更草案（D6 派单通道未就绪的简化落盘形态）；
 * preference/execution-knowledge → 角色记忆草稿（memory_proposal 人审卡）。缺类型/未知类型/
 * 落地失败 → 回落知识库条目（#143 行为）。落地通道经 deps.landings 注入，实现见 distill-landings。
 *
 * #146 存量约束审计：蒸馏运行产出新约束（landings.constraint 非空）→ 顺带审计存量 custom
 * 约束（#139 判据「是否还有可被违反的未来场景」，constraint-audit 纯函数 + 判据白名单闸门）
 * → 退役建议清单发 constraint_audit_proposal 人审卡；approveAudit 走 retire 执行
 * （custom-constraints.yml 条目内 retired 元数据段，#82 D6 落点，可恢复），rejectAudit
 * 零副作用且人判保留约束不再进审计输入。零建议不发卡；审计永不阻塞蒸馏主链路。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { eventBus, logger, FileStore } from '@dommaker/studio-shared';
import type { KnowledgeStore, KnowledgeEntry, SourceRef } from '@dommaker/harness';
import { evaluateDistillThreshold, EXITED_MATURITY } from './distill-threshold.js';
import {
  DistillStore,
  type DistillProposal,
  type DistillProposalRecord,
  type DistillProposalStatus,
  type DistillRun,
  type DistillRunLandings,
} from './distill-store.js';
import { postDistillProposalCard } from './distill-proposal-card.js';
import { generateGcCandidates } from './gc-candidates.js';
import { GcStore, type GcProposal, type GcProposalRecord, type GcProposalStatus } from './gc-store.js';
import { postGcProposalCard } from './gc-proposal-card.js';
import {
  CONSTRAINT_AUDIT_SYSTEM_PROMPT,
  buildConstraintAuditPrompt,
  loadActiveCustomConstraints,
  normalizeAuditSuggestions,
  readPackageDeps,
  type AuditSuggestion,
} from './constraint-audit.js';
import {
  ConstraintAuditStore,
  type ConstraintAuditProposal,
  type ConstraintAuditProposalRecord,
  type ConstraintAuditStatus,
} from './audit-store.js';
import { postConstraintAuditCard } from './constraint-audit-card.js';
import { retireConstraintEntry } from '../evolution/applier.js';
import { getSystemExecutor } from '../agents/system-executor.js';
import {
  tokenBudgetGuardEnabled,
  resolveDailyTokenBudget,
  getDailyTokenUsage,
} from '../agents/loop/daily-token-budget.js';
import { writeStudioEvent } from '../../utils/studio-events.js';
import type { WorkUnitData } from '../workunit/workunit.service.js';

export type { DistillProposal, DistillProposalRecord, DistillProposalStatus, DistillRun } from './distill-store.js';
export type { GcProposal, GcProposalRecord, GcProposalStatus } from './gc-store.js';
export type { GcCandidate } from './gc-candidates.js';
export type { ConstraintAuditProposal, ConstraintAuditProposalRecord, ConstraintAuditStatus } from './audit-store.js';
export type { AuditSuggestion, AuditCategory, CustomConstraintInfo } from './constraint-audit.js';

/**
 * 蒸馏 prompt（单一来源）：矿石 → 带类型分类的蒸馏产物。结构参考 MEMORY_EXTRACTION_SYSTEM_PROMPT，
 * 但产出目标不同（项目级知识 + 三分落地，非角色记忆草稿）。类型分类驱动 #145 三分落地分流。
 */
export const DISTILL_SYSTEM_PROMPT = `你是知识蒸馏专家。输入是一批「矿石」知识条目（开发会话自动沉淀的原始记录，单条知识含量低）。

你的任务：把它们提炼成可复用的知识产物——找出重复出现的模式 / 有效做法 / 失败教训，合并同类，剔除噪音。

每条产物要求：
- type：产物类型，四选一——
  - "skill"：过程性知识（可复用的操作流程/方法步骤）→ 落 skills 库提案
  - "constraint"：边界性知识（什么不能做/必须做的规矩）→ 落约束变更草案
  - "preference"：偏好约定（风格/口味/习惯）→ 落角色记忆草稿
  - "execution-knowledge"：执行经验（怎么做成/怎么失败的教训）→ 落角色记忆草稿
  拿不准就不要硬分类，省略 type 字段（回落为普通知识条目）
- title：一句话概括模式（不要复读原料标题）
- content：模式正文——描述 + 适用场景 + 为什么有效（或根因 + 预防）
- tags：1-3 个英文短横线标签
- 仅 type="constraint" 时附加 change 字段：
  { "action": "add" | "override" | "retire", "constraintId": "短横线约束id",
    "level": "iron_law" | "guideline" | "prompt" | "tip", "message": "约束规则一句话", "description": "补充说明（可选）" }
  action 语义：add=新增约束；override=覆盖既有同 id 约束；retire=退役既有约束（只需 action + constraintId）

输出 JSON（不要 markdown 包裹）：
{ "products": [ { "type": "...", "title": "...", "content": "...", "tags": ["..."] } ] }

只产出有复用价值的条目；原料里没有可提炼的模式就返回空数组；最多 5 条，宁缺毋滥。`;

/** 单条原料进 prompt 的正文截断（控制单次调用规模，同 TRANSCRIPT_MAX_CHARS 精神） */
const MATERIAL_CONTENT_MAX_CHARS = 800;

/** 单次蒸馏最多产出的条目数（与 prompt 约定一致） */
const MAX_PRODUCTS = 5;

export interface DistillServiceDeps {
  store: KnowledgeStore;
  fileStore: FileStore;
  /** 数据区目录（proposals.jsonl + runs.jsonl）；运行时装配 studioPath('distill') */
  dataDir: string;
  /** studio-events.jsonl 路径（预算统计与事件落盘共用） */
  eventsFile: string;
  /** 产物入库后的回调（运行时装配 scheduleVectorDbSync）；可选 */
  onProductsSaved?: (productIds: string[]) => void;
  /** #145 三分落地通道（运行时装配 distill-landings）；缺省/失败/返回 null → 回落知识条目 */
  landings?: DistillLandings;
  /** #146 存量约束审计：custom-constraints.yml 路径（运行时装配）；缺省 → 审计跳过 */
  constraintsFile?: string;
  /** #146 审计判据证据：package.json 路径（技术存量信号）；缺省 → prompt 降级保守判断 */
  packageJsonFile?: string;
}

/** #145 产物类型：三通道 + knowledge 回落 */
export type DistillProductType = 'knowledge' | 'skill' | 'constraint' | 'preference' | 'execution-knowledge';

/** 约束变更草案参数（仅 type=constraint 产物携带） */
export interface DistillConstraintChange {
  action: 'add' | 'override' | 'retire';
  constraintId: string;
  level?: string;
  message?: string;
  description?: string;
}

/** normalize 后的产物形态（路由与落地通道的输入） */
export interface NormalizedDistillProduct {
  type: DistillProductType;
  title: string;
  content: string;
  tags: string[];
  change?: DistillConstraintChange;
}

/** 落地通道上下文：sourceReferences 原料指针 + 提案/运行回指 */
export interface DistillLandingCtx {
  materialIds: string[];
  proposalId: string;
  runId: string;
}

/** 落地通道：返回落地产物 id；返回 null / 抛错 → 调用方回落知识条目（产物不丢） */
export type DistillLanding = (product: NormalizedDistillProduct, ctx: DistillLandingCtx) => Promise<string | null>;

export interface DistillLandings {
  skill?: DistillLanding;
  constraint?: DistillLanding;
  /** preference 与 execution-knowledge 共用（角色记忆草稿通道） */
  memory?: DistillLanding;
}

export interface DistillApproveResult {
  ok: boolean;
  productIds?: string[];
  error?: string;
  /** 预算熔断跳过：提案保持 pending，可次日重试 */
  skipped?: 'budget-exhausted';
}

/** LLM 产出的原始产物形态（宽松解析，normalize 把关） */
interface RawDistillProduct {
  type?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  change?: unknown;
}

const CONSTRAINT_ACTIONS = new Set(['add', 'override', 'retire']);

/** 与 harness ConstraintLevel 对齐的四值白名单（prompt 已声明；LLM 乱给 level 丢弃不进草案） */
const CONSTRAINT_LEVELS = new Set(['iron_law', 'guideline', 'prompt', 'tip']);

/** LLM 原始 change 字段 → 约束变更草案参数；不合法返回 null（调用方回落 knowledge） */
function normalizeConstraintChange(raw: unknown): DistillConstraintChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const action = typeof c.action === 'string' ? c.action : '';
  const constraintId = typeof c.constraintId === 'string' ? c.constraintId.trim() : '';
  if (!CONSTRAINT_ACTIONS.has(action) || !constraintId) return null;
  return {
    action: action as DistillConstraintChange['action'],
    constraintId,
    ...(typeof c.level === 'string' && CONSTRAINT_LEVELS.has(c.level.trim()) ? { level: c.level.trim() } : {}),
    ...(typeof c.message === 'string' && c.message.trim() ? { message: c.message.trim() } : {}),
    ...(typeof c.description === 'string' && c.description.trim() ? { description: c.description.trim() } : {}),
  };
}

// 'constraint' 不在此集合：约束产物必须带合法 change（上方分支已处理），否则回落 knowledge
const PRODUCT_TYPES = new Set<DistillProductType>(['skill', 'preference', 'execution-knowledge']);

/**
 * LLM 产出 → 类型化产物清单：缺 title/content 丢弃；tags 只收字符串；
 * 缺/未知 type 回落 knowledge（#143 行为）；constraint 缺合法 change 同样回落 knowledge（产物不丢）。
 */
export function normalizeDistillProducts(parsed: { products?: unknown }): NormalizedDistillProduct[] {
  const raw = Array.isArray(parsed?.products) ? (parsed.products as RawDistillProduct[]) : [];
  const out: NormalizedDistillProduct[] = [];
  for (const p of raw.slice(0, MAX_PRODUCTS)) {
    const title = typeof p?.title === 'string' ? p.title.trim() : '';
    const content = typeof p?.content === 'string' ? p.content.trim() : '';
    if (!title || !content) continue;
    const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
    const rawType = typeof p.type === 'string' ? p.type : '';
    if (rawType === 'constraint') {
      const change = normalizeConstraintChange(p.change);
      if (change) {
        out.push({ type: 'constraint', title, content, tags, change });
        continue;
      }
      // 约束产物缺合法 change → 回落知识条目（不丢产物）
    }
    const type: DistillProductType = PRODUCT_TYPES.has(rawType as DistillProductType)
      ? (rawType as DistillProductType)
      : 'knowledge';
    out.push({ type, title, content, tags });
  }
  return out;
}

/** 原料条目 → 蒸馏输入文本：[id] 标题 + 截断正文 */
export function buildDistillPrompt(materials: KnowledgeEntry[]): string {
  const blocks = materials.map((m, i) => {
    const content = m.content.length > MATERIAL_CONTENT_MAX_CHARS
      ? `${m.content.slice(0, MATERIAL_CONTENT_MAX_CHARS)}…[truncated]`
      : m.content;
    return `### 原料 ${i + 1}（id: ${m.id}）\n标题：${m.title}\n${content}`;
  });
  return `以下是 ${materials.length} 条矿石知识条目，请按系统提示提炼：\n\n${blocks.join('\n\n')}`;
}

export class DistillService {
  private subscribed = false;
  private distillStore: DistillStore;
  private gcStore: GcStore;
  private auditStore: ConstraintAuditStore;

  constructor(private deps: DistillServiceDeps) {
    this.distillStore = new DistillStore(deps.fileStore, deps.dataDir);
    this.gcStore = new GcStore(deps.fileStore, deps.dataDir);
    this.auditStore = new ConstraintAuditStore(deps.fileStore, deps.dataDir);
  }

  /** 订阅 workunit.status_changed（done → 门槛检测）。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done') return;
      // fire-and-forget：门槛检测 + 发卡绝不能阻塞 WU 收尾订阅链
      void this.maybePropose({ workUnitId: wu.id }).catch(err =>
        logger.warn('[Distill] maybePropose failed (non-blocking)', { wuId: wu.id, error: String(err) }),
      );
    });
  }

  /**
   * 门槛检测入口（事件订阅与测试直接调用）：纯确定性计数，零 LLM 成本。
   * 命中 → 建提案 + 发卡；永不抛（所有失败内部 catch 记日志）。
   */
  async maybePropose(trigger: { workUnitId?: string }): Promise<void> {
    try {
      const baseline = {
        lastRunAt: await this.distillStore.lastRunAt(),
        lastConsumedAt: await this.distillStore.lastConsumedAt(),
      };
      const entries = this.deps.store.list();
      const result = evaluateDistillThreshold(entries, baseline);
      if (!result.fire) {
        logger.debug('[Distill] threshold not fired', { reason: result.reason, workUnitId: trigger.workUnitId });
        return;
      }

      // 去重：已有 pending 提案等人审 → 不重复发卡
      const pending = await this.distillStore.findPending();
      if (pending) {
        logger.info('[Distill] skip: pending proposal exists', { proposalId: pending.id, workUnitId: trigger.workUnitId });
        return;
      }

      const byId = new Map(entries.map(e => [e.id, e]));
      const proposal: DistillProposal = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        materialIds: result.materialIds,
        materials: result.materialIds.map(id => ({ id, title: byId.get(id)?.title ?? id })),
        signals: {
          topicTags: result.signals.topicGroups.map(g => g.tag),
          manualCount: result.signals.manualEntryIds.length,
        },
        ...(trigger.workUnitId ? { triggerWorkUnitId: trigger.workUnitId } : {}),
      };
      await this.distillStore.appendProposal(proposal);

      // 发卡失败静默跳过（#101 降级口径）：标记 card-failed，不阻塞后续提案
      const posted = await postDistillProposalCard(proposal, { fileStore: this.deps.fileStore });
      if (!posted) {
        await this.distillStore.appendStatus(proposal.id, 'card-failed');
        await this.emitEvent({ stage: 'card-failed', proposalId: proposal.id, materialCount: proposal.materialIds.length });
        return;
      }

      logger.info('[Distill] proposal posted', {
        proposalId: proposal.id, materialCount: proposal.materialIds.length, workUnitId: trigger.workUnitId,
      });
      await this.emitEvent({
        stage: 'proposal-posted',
        proposalId: proposal.id,
        materialCount: proposal.materialIds.length,
        signals: proposal.signals,
        workUnitId: trigger.workUnitId ?? null,
      });
    } catch (err) {
      logger.warn('[Distill] maybePropose failed (non-blocking)', { workUnitId: trigger.workUnitId, error: String(err) });
    }
  }

  /**
   * approve：预算守卫 → 收集原料 → system-executor 一次蒸馏调用 → 产物入库
   * （sourceReferences 指向全部原料 id）→ 原料归档 → 运行记录 + 事件。
   * LLM/解析失败：原料不消费，落 failed 运行记录（同样触发 7 天熔断）。
   */
  async approve(proposalId: string): Promise<DistillApproveResult> {
    const proposal = await this.distillStore.getProposal(proposalId);
    if (!proposal) return { ok: false, error: 'proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `proposal-not-pending:${proposal.status}` };

    // 熔断：每日 token 预算超限 → 跳过执行（不消费、不报错；提案保持 pending 可次日重试）
    if (await this.isBudgetExhausted()) {
      logger.warn('[Distill] approve skipped: daily token budget exhausted', { proposalId });
      await this.emitEvent({ stage: 'skipped', reason: 'budget-exhausted', proposalId });
      return { ok: false, skipped: 'budget-exhausted' };
    }

    // 以库内最新状态为准（提案后原料可能已被其它路径归档/删除）
    const materials = proposal.materialIds
      .map(id => this.deps.store.get(id))
      .filter((e): e is KnowledgeEntry => !!e && !EXITED_MATURITY.has(e.maturity));
    if (materials.length === 0) {
      await this.distillStore.appendStatus(proposalId, 'failed');
      await this.emitEvent({ stage: 'failed', reason: 'no-materials', proposalId });
      return { ok: false, error: 'no-materials' };
    }

    const startMs = Date.now();
    const runId = randomUUID();
    try {
      const parsed = await getSystemExecutor().runJson<{ products?: unknown }>(
        buildDistillPrompt(materials),
        { systemPrompt: DISTILL_SYSTEM_PROMPT, eventSource: 'knowledge-distill' },
      );
      const products = normalizeDistillProducts(parsed);
      const now = new Date().toISOString();
      const materialIds = materials.map(m => m.id);

      // #145 三分落地：按产物类型路由到对应通道；通道未接线/返回 null/抛错 → 回落知识条目
      const productIds: string[] = [];
      const landings: DistillRunLandings = { knowledge: [], skill: [], constraint: [], memory: [] };
      for (const p of products) {
        const bucket = this.landingBucket(p.type);
        const landing = bucket === 'knowledge' ? null : this.deps.landings?.[bucket];
        let landedId: string | null = null;
        if (landing) {
          try {
            landedId = await landing(p, { materialIds, proposalId, runId });
          } catch (err) {
            logger.warn('[Distill] landing failed, fallback to knowledge entry', {
              proposalId, type: p.type, title: p.title, error: String(err),
            });
          }
        }
        if (landedId) {
          landings[bucket].push(landedId);
          productIds.push(landedId);
        } else {
          if (bucket !== 'knowledge') {
            logger.warn('[Distill] landing unavailable, fallback to knowledge entry', { proposalId, type: p.type, title: p.title });
          }
          const entry = this.buildProductEntry(p, materials, now);
          this.deps.store.save(entry);
          landings.knowledge.push(entry.id);
          productIds.push(entry.id);
        }
      }

      // 蒸馏即消费：有产物才归档原料（空产出不消费，原料留待下轮）
      if (productIds.length > 0) {
        for (const m of materials) {
          this.deps.store.update(m.id, { maturity: 'archived' });
        }
      }

      const run = this.buildRun(proposal, 'executed', productIds, { id: runId, landings });
      await this.distillStore.appendRun(run);
      await this.distillStore.appendStatus(proposalId, 'executed');
      this.deps.onProductsSaved?.(productIds);

      logger.info('[Distill] run executed', {
        proposalId, materialCount: materials.length, productCount: productIds.length, landings, durationMs: Date.now() - startMs,
      });
      await this.emitEvent({
        stage: 'executed',
        proposalId,
        materialIds,
        productIds,
        landings,
        durationMs: Date.now() - startMs,
      });
      // 蒸馏运行 = GC 事件源（#144）：每次执行成功的运行后按周期计龄出候选清单（永不抛）
      await this.runGcCheck(run);
      // 新约束入库 = 存量约束审计事件源（#146）：本次运行产出约束草案才触发（永不抛）
      if ((run.landings?.constraint.length ?? 0) > 0) {
        await this.runConstraintAudit(run);
      }
      return { ok: true, productIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[Distill] run failed (materials not consumed)', { proposalId, error: message });
      const run = this.buildRun(proposal, 'failed', [], { error: message });
      await this.distillStore.appendRun(run);
      await this.distillStore.appendStatus(proposalId, 'failed');
      await this.emitEvent({ stage: 'failed', reason: message, proposalId, durationMs: Date.now() - startMs });
      // 失败运行不构成蒸馏周期（同 #143 消费基线「失败不推进」口径）→ 不触发 GC
      return { ok: false, error: message };
    }
  }

  /** reject：零副作用——原料不动、无产物、无运行记录，仅提案终态 + 事件 */
  async reject(proposalId: string): Promise<{ ok: boolean; error?: string }> {
    const proposal = await this.distillStore.getProposal(proposalId);
    if (!proposal) return { ok: false, error: 'proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `proposal-not-pending:${proposal.status}` };

    await this.distillStore.appendStatus(proposalId, 'rejected');
    logger.info('[Distill] proposal rejected (no side effects)', { proposalId });
    await this.emitEvent({ stage: 'rejected', proposalId, materialCount: proposal.materialIds.length });
    return { ok: true };
  }

  /** 卡片刷新派生已审态（同 role-memory draft-status 口径） */
  async getProposalStatuses(ids: string[]): Promise<Record<string, DistillProposalStatus | 'unknown'>> {
    const proposals = await this.distillStore.listProposals();
    const byId = new Map(proposals.map(p => [p.id, p.status]));
    const statuses: Record<string, DistillProposalStatus | 'unknown'> = {};
    for (const id of ids) statuses[id] = byId.get(id) ?? 'unknown';
    return statuses;
  }

  // ── 测试与路由只读出口 ──

  async getProposal(id: string): Promise<DistillProposalRecord | null> {
    return this.distillStore.getProposal(id);
  }

  async listProposals(): Promise<DistillProposalRecord[]> {
    return this.distillStore.listProposals();
  }

  async listRuns(): Promise<DistillRun[]> {
    return this.distillStore.listRuns();
  }

  // ── #144 GC 候选清单与人审归档 ──

  /**
   * 蒸馏运行后的 GC 检查（approve 内部调用 + 测试直驱）：按蒸馏周期计龄生成候选清单，
   * 非零则建 GC 提案 + 发 gc_proposal 人审卡；零候选不发卡。永不抛（不阻塞蒸馏主链路）。
   * 去重口径：已有 pending GC 提案不重复发卡；曾被 reject 的条目（人判保留）不再提案。
   */
  async runGcCheck(triggerRun: DistillRun): Promise<void> {
    try {
      // 蒸馏周期 = 执行成功的运行（失败运行不构成周期，同 #143 消费基线「失败不推进」口径）
      const runs = await this.distillStore.listRuns();
      const cycles = runs.filter(r => r.outcome === 'executed').map(r => r.executedAt);
      const result = generateGcCandidates(this.deps.store.list(), cycles);
      if (result.candidates.length === 0) {
        logger.debug('[Distill] GC: no candidates', { runId: triggerRun.id, mainAreaCount: result.mainAreaCount });
        return;
      }

      // 人判保留（reject）的条目不再重复提案打扰
      const rejected = await this.gcStore.rejectedEntryIds();
      const candidates = result.candidates.filter(c => !rejected.has(c.entryId));
      if (candidates.length === 0) {
        logger.debug('[Distill] GC: all candidates previously rejected by human', { runId: triggerRun.id });
        return;
      }

      // 已有 pending GC 提案等人审 → 不重复发卡
      const pending = await this.gcStore.findPending();
      if (pending) {
        logger.info('[Distill] GC skip: pending proposal exists', { gcProposalId: pending.id, runId: triggerRun.id });
        return;
      }

      const proposal: GcProposal = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        runId: triggerRun.id,
        candidates,
        forced: result.forced,
        mainAreaCount: result.mainAreaCount,
      };
      await this.gcStore.appendProposal(proposal);

      // 发卡失败静默跳过（#101 降级口径）：标记 card-failed，不阻塞蒸馏主链路
      const posted = await postGcProposalCard(proposal, { fileStore: this.deps.fileStore });
      if (!posted) {
        await this.gcStore.appendStatus(proposal.id, 'card-failed');
        await this.emitEvent({ stage: 'gc-card-failed', gcProposalId: proposal.id, candidateCount: candidates.length });
        return;
      }

      logger.info('[Distill] GC proposal posted', {
        gcProposalId: proposal.id, candidateCount: candidates.length, forced: result.forced, runId: triggerRun.id,
      });
      await this.emitEvent({
        stage: 'gc-proposal-posted',
        gcProposalId: proposal.id,
        runId: triggerRun.id,
        candidateCount: candidates.length,
        forced: result.forced,
        mainAreaCount: result.mainAreaCount,
      });
    } catch (err) {
      logger.warn('[Distill] runGcCheck failed (non-blocking)', { runId: triggerRun.id, error: String(err) });
    }
  }

  /**
   * approve GC 清单：候选条目 maturity=archived 移出主区（可恢复——FileKnowledgeStore
   * 归档不搬文件，改回 active 即恢复）。人审期间已被其它路径退出主区的条目跳过。
   */
  async approveGc(gcProposalId: string): Promise<{ ok: boolean; archivedIds?: string[]; error?: string }> {
    const proposal = await this.gcStore.getProposal(gcProposalId);
    if (!proposal) return { ok: false, error: 'gc-proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `gc-proposal-not-pending:${proposal.status}` };

    const archivedIds: string[] = [];
    for (const c of proposal.candidates) {
      const entry = this.deps.store.get(c.entryId);
      if (!entry || EXITED_MATURITY.has(entry.maturity)) continue; // 已被其它路径退出主区
      this.deps.store.update(c.entryId, { maturity: 'archived' });
      archivedIds.push(c.entryId);
    }

    await this.gcStore.appendStatus(gcProposalId, 'executed');
    if (archivedIds.length > 0) this.deps.onProductsSaved?.(archivedIds); // 知识库变动 → 向量库同步
    logger.info('[Distill] GC executed', { gcProposalId, archivedCount: archivedIds.length });
    await this.emitEvent({
      stage: 'gc-executed',
      gcProposalId,
      archivedIds,
      candidateCount: proposal.candidates.length,
    });
    return { ok: true, archivedIds };
  }

  /** reject GC 清单：零副作用——条目全部保留，仅提案终态 + 事件；被拒条目后续运行不再提案 */
  async rejectGc(gcProposalId: string): Promise<{ ok: boolean; error?: string }> {
    const proposal = await this.gcStore.getProposal(gcProposalId);
    if (!proposal) return { ok: false, error: 'gc-proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `gc-proposal-not-pending:${proposal.status}` };

    await this.gcStore.appendStatus(gcProposalId, 'rejected');
    logger.info('[Distill] GC proposal rejected (entries kept)', { gcProposalId });
    await this.emitEvent({
      stage: 'gc-rejected', gcProposalId, candidateCount: proposal.candidates.length,
    });
    return { ok: true };
  }

  /** GC 卡片刷新派生已审态（同蒸馏提案口径） */
  async getGcProposalStatuses(ids: string[]): Promise<Record<string, GcProposalStatus | 'unknown'>> {
    const proposals = await this.gcStore.listProposals();
    const byId = new Map(proposals.map(p => [p.id, p.status]));
    const statuses: Record<string, GcProposalStatus | 'unknown'> = {};
    for (const id of ids) statuses[id] = byId.get(id) ?? 'unknown';
    return statuses;
  }

  async getGcProposal(id: string): Promise<GcProposalRecord | null> {
    return this.gcStore.getProposal(id);
  }

  async listGcProposals(): Promise<GcProposalRecord[]> {
    return this.gcStore.listProposals();
  }

  // ── #146 存量约束审计（挂蒸馏事件：新约束入库才触发） ──

  /**
   * 蒸馏运行后的存量约束审计（approve 内部在产出新约束时调用 + 测试直驱）：
   * 读 custom-constraints.yml active 条目 → LLM 按「是否还有可被违反的未来场景」判据
   * 出退役建议 → 判据白名单闸门过滤（constraint-audit.normalizeAuditSuggestions）→
   * 非零则建审计提案 + 发 constraint_audit_proposal 人审卡；零建议不发卡（零噪音）。
   * 永不抛（不阻塞蒸馏主链路）。去重口径：已有 pending 审计提案不重复发卡；
   * 曾被 reject 的约束（人判保留）剔除出审计输入；预算耗尽跳过（不报错）。
   */
  async runConstraintAudit(triggerRun: DistillRun): Promise<void> {
    try {
      const file = this.deps.constraintsFile;
      if (!file) {
        logger.debug('[Distill] constraint audit skip: no constraintsFile wired', { runId: triggerRun.id });
        return;
      }
      const active = loadActiveCustomConstraints(file);
      if (active.length === 0) {
        logger.debug('[Distill] constraint audit skip: no active custom constraints', { runId: triggerRun.id });
        return;
      }
      // 人判保留（reject）的约束剔除出审计输入，不再重复提案打扰
      const rejected = await this.auditStore.rejectedConstraintIds();
      const auditables = active.filter(c => !rejected.has(c.id));
      if (auditables.length === 0) {
        logger.debug('[Distill] constraint audit skip: all constraints human-kept', { runId: triggerRun.id });
        return;
      }
      // 已有 pending 审计提案等人审 → 不重复发卡（不进 LLM，零成本）
      const pending = await this.auditStore.findPending();
      if (pending) {
        logger.info('[Distill] constraint audit skip: pending proposal exists', { auditProposalId: pending.id, runId: triggerRun.id });
        return;
      }
      // 预算守卫（与蒸馏 approve 同口径）：耗尽 → 跳过审计，不报错不提案
      if (await this.isBudgetExhausted()) {
        logger.warn('[Distill] constraint audit skipped: daily token budget exhausted', { runId: triggerRun.id });
        return;
      }

      const parsed = await getSystemExecutor().runJson<{ suggestions?: unknown }>(
        buildConstraintAuditPrompt(auditables, { packageDeps: this.deps.packageJsonFile ? readPackageDeps(this.deps.packageJsonFile) : [] }),
        { systemPrompt: CONSTRAINT_AUDIT_SYSTEM_PROMPT, eventSource: 'constraint-audit' },
      );
      const suggestions = normalizeAuditSuggestions(parsed, new Set(auditables.map(c => c.id)));
      if (suggestions.length === 0) {
        logger.debug('[Distill] constraint audit: no suggestions', { runId: triggerRun.id, auditedCount: auditables.length });
        return;
      }

      const proposal: ConstraintAuditProposal = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        runId: triggerRun.id,
        suggestions,
        auditedCount: auditables.length,
      };
      await this.auditStore.appendProposal(proposal);

      // 发卡失败静默跳过（#101 降级口径）：标记 card-failed，不阻塞蒸馏主链路
      const posted = await postConstraintAuditCard(proposal, { fileStore: this.deps.fileStore });
      if (!posted) {
        await this.auditStore.appendStatus(proposal.id, 'card-failed');
        await this.emitEvent({ stage: 'audit-card-failed', auditProposalId: proposal.id, suggestionCount: suggestions.length });
        return;
      }

      logger.info('[Distill] constraint audit proposal posted', {
        auditProposalId: proposal.id, suggestionCount: suggestions.length, auditedCount: auditables.length, runId: triggerRun.id,
      });
      await this.emitEvent({
        stage: 'audit-proposal-posted',
        auditProposalId: proposal.id,
        runId: triggerRun.id,
        suggestionCount: suggestions.length,
        auditedCount: auditables.length,
      });
    } catch (err) {
      logger.warn('[Distill] runConstraintAudit failed (non-blocking)', { runId: triggerRun.id, error: String(err) });
    }
  }

  /**
   * approve 审计清单：逐条走 retire 执行——custom-constraints.yml 既有条目内追加
   * retired 元数据段（#82 D6 统一落点，复用 E1 applier retireConstraintEntry；
   * 规则原文保留，可恢复：POST /api/v1/harness/constraints/:id/rollback 删段即恢复）。
   * 人审期间已被其它路径退役/删除、或文本定位失败的条目跳过（幂等），
   * 跳过名单随返回值与事件给出（skippedIds），人审可见哪些建议未真正执行。
   */
  async approveAudit(auditProposalId: string): Promise<{ ok: boolean; retiredIds?: string[]; skippedIds?: string[]; error?: string }> {
    const proposal = await this.auditStore.getProposal(auditProposalId);
    if (!proposal) return { ok: false, error: 'audit-proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `audit-proposal-not-pending:${proposal.status}` };
    const file = this.deps.constraintsFile;
    if (!file) return { ok: false, error: 'constraints-file-unavailable' };

    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const now = new Date().toISOString();
    const retiredIds: string[] = [];
    const skippedIds: string[] = [];
    for (const s of proposal.suggestions) {
      const next = retireConstraintEntry(content, s.constraintId, {
        at: now,
        reason: `[${s.category}] ${s.rationale}`,
      });
      if (next === null) {
        skippedIds.push(s.constraintId); // 条目不存在 / 已退役 / 文本定位失败
        continue;
      }
      content = next;
      retiredIds.push(s.constraintId);
    }
    if (retiredIds.length > 0) {
      fs.writeFileSync(file, content, 'utf-8');
    }

    await this.auditStore.appendStatus(auditProposalId, 'executed');
    logger.info('[Distill] constraint audit executed', { auditProposalId, retiredCount: retiredIds.length, skippedCount: skippedIds.length });
    await this.emitEvent({
      stage: 'audit-executed',
      auditProposalId,
      retiredIds,
      skippedIds,
      suggestionCount: proposal.suggestions.length,
    });
    return { ok: true, retiredIds, skippedIds };
  }

  /** reject 审计清单：零副作用——约束全部保留，仅提案终态 + 事件；被拒约束后续不再进审计输入 */
  async rejectAudit(auditProposalId: string): Promise<{ ok: boolean; error?: string }> {
    const proposal = await this.auditStore.getProposal(auditProposalId);
    if (!proposal) return { ok: false, error: 'audit-proposal-not-found' };
    if (proposal.status !== 'pending') return { ok: false, error: `audit-proposal-not-pending:${proposal.status}` };

    await this.auditStore.appendStatus(auditProposalId, 'rejected');
    logger.info('[Distill] constraint audit rejected (constraints kept)', { auditProposalId });
    await this.emitEvent({
      stage: 'audit-rejected', auditProposalId, suggestionCount: proposal.suggestions.length,
    });
    return { ok: true };
  }

  /** 审计卡片刷新派生已审态（同蒸馏提案口径） */
  async getAuditProposalStatuses(ids: string[]): Promise<Record<string, ConstraintAuditStatus | 'unknown'>> {
    const proposals = await this.auditStore.listProposals();
    const byId = new Map(proposals.map(p => [p.id, p.status]));
    const statuses: Record<string, ConstraintAuditStatus | 'unknown'> = {};
    for (const id of ids) statuses[id] = byId.get(id) ?? 'unknown';
    return statuses;
  }

  async getAuditProposal(id: string): Promise<ConstraintAuditProposalRecord | null> {
    return this.auditStore.getProposal(id);
  }

  async listAuditProposals(): Promise<ConstraintAuditProposalRecord[]> {
    return this.auditStore.listProposals();
  }

  /** 每日 token 预算熔断判定（与 WuCompletionExtractor 同口径） */
  private async isBudgetExhausted(): Promise<boolean> {
    if (!tokenBudgetGuardEnabled()) return false;
    const budget = resolveDailyTokenBudget();
    if (budget <= 0) return false;
    const daily = await getDailyTokenUsage({ eventsFile: this.deps.eventsFile });
    return daily.usedTokens >= budget;
  }

  /** 产物条目：guideline / active / reference / origin=system；sourceReferences 回指全部原料 id */
  private buildProductEntry(
    p: { title: string; content: string; tags: string[] },
    materials: KnowledgeEntry[],
    now: string,
  ): KnowledgeEntry {
    // SourceRef.entryId（harness#23）已落地，直接以 SourceRef[] 构造，去掉强转（#148）
    const sourceReferences: SourceRef[] = materials.map(m => ({
      workflow: 'distill',
      entryId: m.id,
      timestamp: now,
    }));
    return {
      id: randomUUID(),
      type: 'guideline',
      title: p.title,
      content: p.content,
      maturity: 'active',
      layer: 'project',
      created: now,
      lastReferenced: now,
      contributors: ['distill'],
      projects: [],
      tags: ['distilled', ...p.tags],
      applicablePhases: [],
      sourceReferences,
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'system',
    };
  }

  /** 产物类型 → 落地桶（preference/execution-knowledge 共用 memory 通道） */
  private landingBucket(type: DistillProductType): keyof DistillRunLandings {
    if (type === 'skill') return 'skill';
    if (type === 'constraint') return 'constraint';
    if (type === 'preference' || type === 'execution-knowledge') return 'memory';
    return 'knowledge';
  }

  private buildRun(
    proposal: DistillProposal,
    outcome: DistillRun['outcome'],
    productIds: string[],
    extra?: { id?: string; landings?: DistillRunLandings; error?: string },
  ): DistillRun {
    return {
      id: extra?.id ?? randomUUID(),
      proposalId: proposal.id,
      executedAt: new Date().toISOString(),
      outcome,
      signals: proposal.signals,
      materialIds: proposal.materialIds,
      productIds,
      ...(extra?.landings ? { landings: extra.landings } : {}),
      ...(extra?.error ? { error: extra.error } : {}),
    };
  }

  /** 落 knowledge:distill 事件（统一入口 writeStudioEvent：永不抛，空 payload 拒写） */
  private async emitEvent(payload: Record<string, unknown>): Promise<void> {
    await writeStudioEvent('knowledge:distill', payload, {
      source: 'distill',
      file: this.deps.eventsFile,
    });
  }
}
