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
 * 三分落地（skill/约束/角色记忆分流）归 #145；本票产物统一入库为知识条目。
 *
 * #144 GC 候选清单：每次蒸馏运行落盘后 runGcCheck 按蒸馏周期计龄（gc-candidates 纯函数，
 * 不读墙钟）生成候选清单发 gc_proposal 人审卡；approveGc 候选 maturity=archived（可恢复），
 * rejectGc 零副作用且人判保留条目后续不再提案。零候选不发卡。
 */
import { randomUUID } from 'node:crypto';
import { eventBus, logger, FileStore } from '@dommaker/studio-shared';
import type { KnowledgeStore, KnowledgeEntry, SourceRef } from '@dommaker/harness';
import { evaluateDistillThreshold, EXITED_MATURITY } from './distill-threshold.js';
import {
  DistillStore,
  type DistillProposal,
  type DistillProposalRecord,
  type DistillProposalStatus,
  type DistillRun,
} from './distill-store.js';
import { postDistillProposalCard } from './distill-proposal-card.js';
import { generateGcCandidates } from './gc-candidates.js';
import { GcStore, type GcProposal, type GcProposalRecord, type GcProposalStatus } from './gc-store.js';
import { postGcProposalCard } from './gc-proposal-card.js';
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

/**
 * 蒸馏 prompt（单一来源）：矿石 → 蒸馏知识条目。结构参考 MEMORY_EXTRACTION_SYSTEM_PROMPT，
 * 但产出目标不同（项目级知识条目，非角色记忆草稿）。产物三分落地归 #145，本票统一入库。
 */
export const DISTILL_SYSTEM_PROMPT = `你是知识蒸馏专家。输入是一批「矿石」知识条目（开发会话自动沉淀的原始记录，单条知识含量低）。

你的任务：把它们提炼成可复用的知识条目——找出重复出现的模式 / 有效做法 / 失败教训，合并同类，剔除噪音。

每条产物要求：
- title：一句话概括模式（不要复读原料标题）
- content：模式正文——描述 + 适用场景 + 为什么有效（或根因 + 预防）
- tags：1-3 个英文短横线标签

输出 JSON（不要 markdown 包裹）：
{ "products": [ { "title": "...", "content": "...", "tags": ["..."] } ] }

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
  title?: unknown;
  content?: unknown;
  tags?: unknown;
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

/** LLM 产出 → 产物清单：缺 title/content 丢弃；tags 只收字符串 */
export function normalizeDistillProducts(parsed: { products?: unknown }): Array<{ title: string; content: string; tags: string[] }> {
  const raw = Array.isArray(parsed?.products) ? (parsed.products as RawDistillProduct[]) : [];
  const out: Array<{ title: string; content: string; tags: string[] }> = [];
  for (const p of raw.slice(0, MAX_PRODUCTS)) {
    const title = typeof p?.title === 'string' ? p.title.trim() : '';
    const content = typeof p?.content === 'string' ? p.content.trim() : '';
    if (!title || !content) continue;
    const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
    out.push({ title, content, tags });
  }
  return out;
}

export class DistillService {
  private subscribed = false;
  private distillStore: DistillStore;
  private gcStore: GcStore;

  constructor(private deps: DistillServiceDeps) {
    this.distillStore = new DistillStore(deps.fileStore, deps.dataDir);
    this.gcStore = new GcStore(deps.fileStore, deps.dataDir);
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
    try {
      const parsed = await getSystemExecutor().runJson<{ products?: unknown }>(
        buildDistillPrompt(materials),
        { systemPrompt: DISTILL_SYSTEM_PROMPT, eventSource: 'knowledge-distill' },
      );
      const products = normalizeDistillProducts(parsed);
      const now = new Date().toISOString();

      // 产物入库为知识条目（sourceReferences 指向全部原料 id）
      const productIds: string[] = [];
      for (const p of products) {
        const entry = this.buildProductEntry(p, materials, now);
        this.deps.store.save(entry);
        productIds.push(entry.id);
      }

      // 蒸馏即消费：有产物才归档原料（空产出不消费，原料留待下轮）
      if (productIds.length > 0) {
        for (const m of materials) {
          this.deps.store.update(m.id, { maturity: 'archived' });
        }
      }

      const run = this.buildRun(proposal, 'executed', productIds);
      await this.distillStore.appendRun(run);
      await this.distillStore.appendStatus(proposalId, 'executed');
      this.deps.onProductsSaved?.(productIds);

      logger.info('[Distill] run executed', {
        proposalId, materialCount: materials.length, productCount: productIds.length, durationMs: Date.now() - startMs,
      });
      await this.emitEvent({
        stage: 'executed',
        proposalId,
        materialIds: materials.map(m => m.id),
        productIds,
        durationMs: Date.now() - startMs,
      });
      // 蒸馏运行 = GC 事件源（#144）：每次执行成功的运行后按周期计龄出候选清单（永不抛）
      await this.runGcCheck(run);
      return { ok: true, productIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[Distill] run failed (materials not consumed)', { proposalId, error: message });
      const run = this.buildRun(proposal, 'failed', [], message);
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
    // harness SourceRef 无 entryId 字段；扩展键随 frontmatter YAML 原样往返（#143 证据链落点）
    const sourceReferences = materials.map(m => ({
      workflow: 'distill',
      entryId: m.id,
      timestamp: now,
    })) as unknown as SourceRef[];
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

  private buildRun(
    proposal: DistillProposal,
    outcome: DistillRun['outcome'],
    productIds: string[],
    error?: string,
  ): DistillRun {
    return {
      id: randomUUID(),
      proposalId: proposal.id,
      executedAt: new Date().toISOString(),
      outcome,
      signals: proposal.signals,
      materialIds: proposal.materialIds,
      productIds,
      ...(error ? { error } : {}),
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
