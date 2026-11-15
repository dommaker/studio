/**
 * distill-service (#143) — 蒸馏主链路最小闭环（#83 D1/D2/D5 落地，spec #141）
 *
 * 链路：WU 收尾钩子（workunit.status_changed → done）顺带跑门槛检测（distill-threshold
 * 纯函数，零 LLM 成本）→ 命中则发 distill_proposal 人审卡到 #系统 频道（原料清单+预期产出）
 * → approve 后由 system-executor 执行一次蒸馏调用 → 产出入库为知识条目（sourceReferences
 * 指向全部原料 id），原料矿石 maturity=archived 移出主区 → 运行记录落数据区（distill-runs），
 * 全链路事件写 studio-events.jsonl（type=knowledge:distill）。
 *
 * #351：人审提案卡生命周期（提案存取/发卡/approve/reject/状态查询）收敛到
 * review-proposal 正本；本 service 只做业务触发（maybePropose/runGcCheck）
 * 与审批后动作（executeDistill/executeGc + reject 事件留痕），
 * 经 registerDistillReviewAdapters 注册两个 adapter（kind: distill/gc）。
 * 人审端点 = 通用端点 /api/v1/review-proposals/:kind/:id/{approve,reject,status}。
 *
 * 降级口径：
 *   - reject 零副作用（原料不动、无产物、无运行记录）
 *   - LLM 失败 / JSON 解析失败 → 原料不消费，run 落 retry-after 并调度；达到上限才 failed
 *   - daily-token-budget 守卫照挂（预算耗尽 → 跳过执行，提案保持 pending 可次日重试）
 *   - 发卡失败静默跳过（提案标记 card-failed，不阻塞后续提案）
 *   - 已有 pending 提案 → 不重复发卡（人去频道处理即可）
 *
 * 事件订阅语义与 WuCompletionExtractor / AnalysisHandoff 一致（eventBus 进程内 best-effort，
 * fire-and-forget，绝不阻塞 WU 收尾）。
 *
 * #144 GC 候选清单：每次蒸馏运行落盘后 runGcCheck 按蒸馏周期计龄（gc-candidates 纯函数，
 * 不读墙钟）生成候选清单发 gc_proposal 人审卡；executeGc 候选 maturity=archived（可恢复），
 * reject 零副作用且人判保留条目后续不再提案。零候选不发卡。
 *
 * #145 产物分类落地：蒸馏 LLM 产出自带类型分类——skill（过程性知识）→ skills 库提案；
 * preference/execution-knowledge → 角色记忆草稿（memory_proposal 人审卡）。缺类型/未知类型/
 * 落地失败 → 回落知识库条目（#143 行为）。落地通道经 deps.landings 注入，实现见 distill-landings。
 * constraint 桶已随 #625 整体退出（#622 裁决：落点为死端，生命周期归 evolution 飞轮）——
 * constraint 类产物按未知类型走既有回落逻辑，产物不丢。
 *
 * #146 存量约束审计子通道（runConstraintAudit/executeAudit + constraint-audit 纯函数）已随
 * #617 拆除：审计对象 custom 纯文本约束已随 ADR-0029 灭绝，无可审对象。
 */
import { randomUUID } from 'node:crypto';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import type { KnowledgeStore, KnowledgeEntry, SourceRef } from '@dommaker/harness';
import { evaluateDistillThreshold, EXITED_MATURITY } from './distill-threshold.js';
import { DistillRunsStore, type DistillRun, type DistillRunLandings, type DistillRunProduct } from './distill-runs.js';
import {
  registerDistillReviewAdapters,
  rejectedGcEntryIds,
  type DistillProposal,
  type DistillReviewAdapters,
  type GcProposal,
} from './review-adapters.js';
import { approveProposal, submitProposal } from '../review-proposal/index.js';
import type { ApproveOutcome } from '../review-proposal/index.js';
import type { ReviewProposalRecord } from '../review-proposal/index.js';
import { generateGcCandidates } from './gc-candidates.js';
import { getSystemExecutor } from '../agents/index.js';
import {
  tokenBudgetGuardEnabled,
  resolveDailyTokenBudget,
  getDailyTokenUsage,
} from '../agent-loop/index.js';
import { writeStudioEvent } from '@dommaker/studio-shared';
import { getErrorMessage } from '../../utils/errors.js';
import type { WorkUnitData } from '../workunit/index.js';
import { logger } from '@dommaker/studio-shared/node';

export type { DistillRun } from './distill-runs.js';
export type { GcCandidate } from './gc-candidates.js';
export type { DistillProposal, GcProposal } from './review-adapters.js';

/**
 * 蒸馏 prompt（单一来源）：矿石 → 带类型分类的蒸馏产物。结构参考 MEMORY_EXTRACTION_SYSTEM_PROMPT，
 * 但产出目标不同（项目级知识 + 分类落地，非角色记忆草稿）。类型分类驱动 #145 落地分流。
 */
export const DISTILL_SYSTEM_PROMPT = `你是知识蒸馏专家。输入是一批「矿石」知识条目（开发会话自动沉淀的原始记录，单条知识含量低）。

你的任务：把它们提炼成可复用的知识产物——找出重复出现的模式 / 有效做法 / 失败教训，合并同类，剔除噪音。

每条产物要求：
- type：产物类型，三选一——
  - "skill"：过程性知识（可复用的操作流程/方法步骤）→ 落 skills 库提案
  - "preference"：偏好约定（风格/口味/习惯）→ 落角色记忆草稿
  - "execution-knowledge"：执行经验（怎么做成/怎么失败的教训）→ 落角色记忆草稿
  拿不准就不要硬分类，省略 type 字段（回落为普通知识条目）
- title：一句话概括模式（不要复读原料标题）
- content：模式正文——描述 + 适用场景 + 为什么有效（或根因 + 预防）
- tags：1-3 个英文短横线标签

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
  /** 数据区目录（三类提案 jsonl + runs.jsonl）；运行时装配 studioPath('distill') */
  dataDir: string;
  /** studio-events.jsonl 路径（预算统计与事件落盘共用） */
  eventsFile: string;
  /** 产物入库后的回调（运行时装配 scheduleVectorDbSync）；可选 */
  onProductsSaved?: (productIds: string[]) => void;
  /** #145 产物落地通道（运行时装配 distill-landings）；缺省/返回 null → 回落知识条目 */
  landings?: DistillLandings;
  /** 临时失败最多执行次数（含首次），默认 3 */
  maxAttempts?: number;
  /** retry-after 到下次唤醒的间隔，默认 30s；进程重启由启动恢复接管 */
  retryDelayMs?: number;
}

/** #145 产物类型：双通道 + knowledge 回落 */
export type DistillProductType = 'knowledge' | 'skill' | 'preference' | 'execution-knowledge';

/** normalize 后的产物形态（路由与落地通道的输入） */
export interface NormalizedDistillProduct {
  type: DistillProductType;
  title: string;
  content: string;
  tags: string[];
}

/** 落地通道上下文：稳定产物身份 + 已落地 id（供恢复认养/重发卡） */
export interface DistillLandingCtx {
  materialIds: string[];
  proposalId: string;
  runId: string;
  productId: string;
  landingId?: string;
  recovery: boolean;
}

export interface DistillLandingResult {
  id: string;
  /** pending/executed 提案或知识条目可恢复；card-failed 必须为 false */
  durable: boolean;
}

/** 返回 null 表示通道不可用可回落；抛错与 durable=false 均进入 retry-after。 */
export type DistillLanding = (
  product: NormalizedDistillProduct,
  ctx: DistillLandingCtx,
) => Promise<string | DistillLandingResult | null>;

export interface DistillLandings {
  skill?: DistillLanding;
  /** preference 与 execution-knowledge 共用（角色记忆草稿通道） */
  memory?: DistillLanding;
}

/** LLM 产出的原始产物形态（宽松解析，normalize 把关） */
interface RawDistillProduct {
  type?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
}

const PRODUCT_TYPES = new Set<DistillProductType>(['skill', 'preference', 'execution-knowledge']);

/**
 * LLM 产出 → 类型化产物清单：缺 title/content 丢弃；tags 只收字符串；
 * 缺/未知 type 回落 knowledge（#143 行为；constraint 桶 #625 退出后按未知类型走同一回落，产物不丢）。
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
  private runsStore: DistillRunsStore;
  private reviewAdapters: DistillReviewAdapters;
  private readonly retries = new Set<string>();
  private readonly inFlight = new Map<string, Promise<ApproveOutcome>>();

  constructor(private deps: DistillServiceDeps) {
    this.runsStore = new DistillRunsStore(deps.fileStore, deps.dataDir);
    // #351：两个人审提案卡 adapter 注册到 review-proposal 正本（kind: distill/gc）。
    // 构造即注册：通用端点经注册表分发到本实例的审批后动作；重复构造后者生效（测试多实例幂等）。
    this.reviewAdapters = registerDistillReviewAdapters({
      fileStore: deps.fileStore,
      dataDir: deps.dataDir,
      effects: {
        executeDistill: p => this.executeDistill(p),
        onDistillRejected: p => this.onDistillRejected(p),
        executeGc: p => this.executeGc(p),
        onGcRejected: p => this.onGcRejected(p),
      },
    });
  }

  /** 订阅 workunit.status_changed（done → 门槛检测）。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData; previousStatus?: string }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done' || payload.previousStatus === 'done') return;
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
        lastRunAt: await this.runsStore.lastRunAt(),
        lastConsumedAt: await this.runsStore.lastConsumedAt(),
      };
      const entries = this.deps.store.list();
      const result = evaluateDistillThreshold(entries, baseline);
      if (!result.fire) {
        logger.debug('[Distill] threshold not fired', { reason: result.reason, workUnitId: trigger.workUnitId });
        return;
      }

      // 去重：已有 pending 提案等人审 → 不重复发卡
      const pending = await this.reviewAdapters.distill.store.findPending();
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

      // 发卡失败静默跳过（#101 降级口径）：正本落 card-failed 墓碑，不阻塞后续提案
      const { posted } = await submitProposal(this.reviewAdapters.distill, proposal);
      if (!posted) {
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
   * adapter.onApprove（kind=distill）：先落 triggered/running，再调用模型与落地。
   * 临时失败落 retry-after，提案保持 pending；达到上限才返回 failed 并由正本落终态墓碑。
   */
  async executeDistill(proposal: ReviewProposalRecord<DistillProposal>): Promise<ApproveOutcome> {
    const existing = this.inFlight.get(proposal.id);
    if (existing) return existing;
    const promise = this.performDistill(proposal).finally(() => this.inFlight.delete(proposal.id));
    this.inFlight.set(proposal.id, promise);
    return promise;
  }

  private async performDistill(proposal: ReviewProposalRecord<DistillProposal>): Promise<ApproveOutcome> {
    const proposalId = proposal.id;
    if (await this.isBudgetExhausted()) {
      logger.warn('[Distill] approve skipped: daily token budget exhausted', { proposalId });
      await this.emitEvent({ stage: 'skipped', reason: 'budget-exhausted', proposalId });
      return { status: 'pending', skipped: 'budget-exhausted' };
    }

    const unfinished = (await this.runsStore.listRuns()).find(run =>
      run.proposalId === proposalId && ['triggered', 'running', 'retry-after'].includes(run.outcome),
    );
    const materials = proposal.materialIds
      .map(id => this.deps.store.get(id))
      .filter((e): e is KnowledgeEntry => !!e && (!EXITED_MATURITY.has(e.maturity) || unfinished !== undefined));
    if (materials.length === 0) {
      await this.emitEvent({ stage: 'failed', reason: 'no-materials', proposalId });
      return { status: 'failed', error: 'no-materials' };
    }

    const startMs = Date.now();
    let run = unfinished ?? this.buildRun(proposal, 'triggered', [], { id: randomUUID(), attempts: 0 });
    if (!unfinished) {
      try {
        await this.runsStore.appendRun(run);
      } catch (err) {
        const nextAttemptAt = new Date(Date.now() + (this.deps.retryDelayMs ?? 30_000)).toISOString();
        this.scheduleRetry(proposalId, nextAttemptAt);
        logger.warn('[Distill] failed to persist triggered run', { proposalId, error: String(err) });
        return { status: 'pending', skipped: 'run-store-unavailable' };
      }
    }

    run = {
      ...run,
      executedAt: new Date().toISOString(),
      outcome: 'running',
      attempts: (run.attempts ?? 0) + 1,
      nextAttemptAt: undefined,
      lastError: undefined,
      error: undefined,
    };
    try {
      // 模型调用前必须先持久化 running，崩溃后由启动恢复认养这次尝试。
      await this.runsStore.appendRun(run);
      if (run.products === undefined) {
        const parsed = await getSystemExecutor().runJson<{ products?: unknown }>(
          buildDistillPrompt(materials),
          { systemPrompt: DISTILL_SYSTEM_PROMPT, eventSource: 'knowledge-distill' },
        );
        run = {
          ...run,
          products: normalizeDistillProducts(parsed).map(p => ({
            ...p, id: randomUUID(), status: 'pending' as const,
          })),
        };
        // 任何产物副作用前先持久化完整清单；后续尝试绝不重跑模型改写身份。
        await this.runsStore.appendRun(run);
      }
      const products = run.products ?? [];
      const materialIds = run.materialIds;
      const summarize = (items: DistillRunProduct[]): { productIds: string[]; landings: DistillRunLandings } => {
        const landings: DistillRunLandings = { knowledge: [], skill: [], memory: [] };
        for (const item of items) {
          if (item.landingId) landings[item.bucket ?? this.landingBucket(item.type)].push(item.landingId);
        }
        return { productIds: items.flatMap(item => item.landingId ? [item.landingId] : []), landings };
      };

      for (const product of products) {
        if (product.status === 'durable') continue;
        const bucket = product.bucket ?? this.landingBucket(product.type);
        const landing = bucket === 'knowledge' ? null : this.deps.landings?.[bucket];
        let landed: { id: string; durable: boolean } | null = null;
        if (landing) {
          const result = await landing(product, {
            materialIds,
            proposalId,
            runId: run.id,
            productId: product.id,
            landingId: product.landingId,
            recovery: unfinished !== undefined,
          });
          landed = typeof result === 'string' ? { id: result, durable: true } : result;
        } else if (product.landingId && bucket !== 'knowledge') {
          // 已有分类产物但恢复时通道未装配，禁止另落 knowledge 后误归档。
          throw new Error(`landing-unavailable-for-recovery:${product.landingId}`);
        }

        if (landed) {
          product.landingId = landed.id;
          product.bucket = bucket;
          product.status = landed.durable ? 'durable' : 'pending';
        } else {
          const existing = product.landingId ? this.deps.store.get(product.landingId) : null;
          if (!existing) {
            const entry = this.buildProductEntry(product, materials, new Date().toISOString(), product.id);
            this.deps.store.save(entry);
          }
          product.landingId = product.landingId ?? product.id;
          product.bucket = 'knowledge';
          product.status = 'durable';
        }
        run = { ...run, products: [...products], ...summarize(products) };
        // 每个产物独立落账：恢复只处理 pending，durable 产物绝不重复调用通道。
        await this.runsStore.appendRun(run);
        if (product.status !== 'durable') throw new Error(`landing-card-failed:${product.landingId}`);
      }

      const { productIds, landings } = summarize(products);
      if (products.length > 0) {
        if (!products.every(product => product.status === 'durable')) throw new Error('products-not-durable');
        for (const m of materials) this.deps.store.update(m.id, { maturity: 'archived' });
      }

      run = {
        ...run,
        executedAt: new Date().toISOString(),
        outcome: 'succeeded',
        productIds,
        landings,
        nextAttemptAt: undefined,
        lastError: undefined,
        error: undefined,
      };
      await this.runsStore.appendRun(run);
      this.deps.onProductsSaved?.(productIds);
      logger.info('[Distill] run succeeded', {
        proposalId, materialCount: materials.length, productCount: productIds.length, landings, durationMs: Date.now() - startMs,
      });
      await this.emitEvent({
        stage: 'executed', proposalId, materialIds, productIds, landings, durationMs: Date.now() - startMs,
      });
      await this.runGcCheck(run);
      return { status: 'executed', data: { productIds } };
    } catch (err) {
      const message = getErrorMessage(err);
      const retry = (run.attempts ?? 1) < (this.deps.maxAttempts ?? 3);
      const nextAttemptAt = retry
        ? new Date(Date.now() + (this.deps.retryDelayMs ?? 30_000)).toISOString()
        : undefined;
      run = {
        ...run,
        executedAt: new Date().toISOString(),
        outcome: retry ? 'retry-after' : 'failed',
        lastError: message,
        nextAttemptAt,
      };
      try {
        await this.runsStore.appendRun(run);
      } catch (storeErr) {
        logger.warn('[Distill] failed to persist run failure', { proposalId, runId: run.id, error: String(storeErr) });
      }
      if (retry) {
        this.scheduleRetry(proposalId, nextAttemptAt);
        await this.emitEvent({ stage: 'retry-after', reason: message, proposalId, runId: run.id, nextAttemptAt });
        return { status: 'pending', skipped: 'retry-after' };
      }
      await this.emitEvent({ stage: 'failed', reason: message, proposalId, runId: run.id, durationMs: Date.now() - startMs });
      return { status: 'failed', error: message };
    }
  }

  /** 到点重试复用正本审批生命周期，由正本统一写成功/失败墓碑。 */
  private async retryProposal(proposalId: string): Promise<void> {
    await approveProposal('distill', proposalId);
  }

  private scheduleRetry(proposalId: string, nextAttemptAt?: string): void {
    if (this.retries.has(proposalId)) return;
    this.retries.add(proposalId);
    const delay = Math.max(0, (nextAttemptAt ? Date.parse(nextAttemptAt) : Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.retries.delete(proposalId);
      void this.retryProposal(proposalId).catch(err =>
        logger.warn('[Distill] scheduled retry failed', { proposalId, error: String(err) }),
      );
    }, delay);
    timer.unref?.();
  }

  /** 启动恢复磁盘上的未完成 run，并为未到期的 retry-after 重建定时器。 */
  async recoverPendingRuns(): Promise<void> {
    const runs = await this.runsStore.listRuns();
    for (const run of runs) {
      if (!['triggered', 'running', 'retry-after'].includes(run.outcome)) continue;
      const proposal = await this.reviewAdapters.distill.store.getProposal(run.proposalId);
      if (!proposal || proposal.status !== 'pending') continue;
      if (run.nextAttemptAt && Date.parse(run.nextAttemptAt) > Date.now()) {
        this.scheduleRetry(run.proposalId, run.nextAttemptAt);
        continue;
      }
      await this.retryProposal(run.proposalId);
    }
  }

  /** adapter.onReject（kind=distill）：零副作用——原料不动、无产物、无运行记录，仅事件留痕 */
  async onDistillRejected(proposal: ReviewProposalRecord<DistillProposal>): Promise<void> {
    logger.info('[Distill] proposal rejected (no side effects)', { proposalId: proposal.id });
    await this.emitEvent({ stage: 'rejected', proposalId: proposal.id, materialCount: proposal.materialIds.length });
  }

  // ── 测试与路由只读出口 ──

  async listRuns(): Promise<DistillRun[]> {
    return this.runsStore.listRuns();
  }

  // ── #144 GC 候选清单与人审归档 ──

  /**
   * 蒸馏运行后的 GC 检查（executeDistill 内部调用 + 测试直驱）：按蒸馏周期计龄生成候选清单，
   * 非零则建 GC 提案 + 发 gc_proposal 人审卡；零候选不发卡。永不抛（不阻塞蒸馏主链路）。
   * 去重口径：已有 pending GC 提案不重复发卡；曾被 reject 的条目（人判保留）不再提案。
   */
  async runGcCheck(triggerRun: DistillRun): Promise<void> {
    try {
      // 蒸馏周期 = 执行成功的运行（失败运行不构成周期，同 #143 消费基线「失败不推进」口径）
      const runs = await this.runsStore.listRuns();
      const cycles = runs.filter(r => r.outcome === 'succeeded' || r.outcome === 'executed').map(r => r.executedAt);
      const result = generateGcCandidates(this.deps.store.list(), cycles);
      if (result.candidates.length === 0) {
        logger.debug('[Distill] GC: no candidates', { runId: triggerRun.id, mainAreaCount: result.mainAreaCount });
        return;
      }

      // 人判保留（reject）的条目不再重复提案打扰
      const rejected = await rejectedGcEntryIds(this.reviewAdapters.gc.store);
      const candidates = result.candidates.filter(c => !rejected.has(c.entryId));
      if (candidates.length === 0) {
        logger.debug('[Distill] GC: all candidates previously rejected by human', { runId: triggerRun.id });
        return;
      }

      // 已有 pending GC 提案等人审 → 不重复发卡
      const pending = await this.reviewAdapters.gc.store.findPending();
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

      // 发卡失败静默跳过（#101 降级口径）：正本落 card-failed 墓碑，不阻塞蒸馏主链路
      const { posted } = await submitProposal(this.reviewAdapters.gc, proposal);
      if (!posted) {
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
   * adapter.onApprove（kind=gc）：候选条目 maturity=archived 移出主区（可恢复——
   * FileKnowledgeStore 归档不搬文件，改回 active 即恢复）。人审期间已被其它路径
   * 退出主区的条目跳过。
   */
  async executeGc(proposal: ReviewProposalRecord<GcProposal>): Promise<ApproveOutcome> {
    const gcProposalId = proposal.id;
    const archivedIds: string[] = [];
    for (const c of proposal.candidates) {
      const entry = this.deps.store.get(c.entryId);
      if (!entry || EXITED_MATURITY.has(entry.maturity)) continue; // 已被其它路径退出主区
      this.deps.store.update(c.entryId, { maturity: 'archived' });
      archivedIds.push(c.entryId);
    }

    if (archivedIds.length > 0) this.deps.onProductsSaved?.(archivedIds); // 知识库变动 → 向量库同步
    logger.info('[Distill] GC executed', { gcProposalId, archivedCount: archivedIds.length });
    await this.emitEvent({
      stage: 'gc-executed',
      gcProposalId,
      archivedIds,
      candidateCount: proposal.candidates.length,
    });
    return { status: 'executed', data: { archivedIds } };
  }

  /** adapter.onReject（kind=gc）：零副作用——条目全部保留，仅事件留痕；被拒条目后续运行不再提案 */
  async onGcRejected(proposal: ReviewProposalRecord<GcProposal>): Promise<void> {
    logger.info('[Distill] GC proposal rejected (entries kept)', { gcProposalId: proposal.id });
    await this.emitEvent({
      stage: 'gc-rejected', gcProposalId: proposal.id, candidateCount: proposal.candidates.length,
    });
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
    id: string,
  ): KnowledgeEntry {
    // SourceRef.entryId（harness#23）已落地，直接以 SourceRef[] 构造，去掉强转（#148）
    const sourceReferences: SourceRef[] = materials.map(m => ({
      workflow: 'distill',
      entryId: m.id,
      timestamp: now,
    }));
    return {
      id,
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
    if (type === 'preference' || type === 'execution-knowledge') return 'memory';
    return 'knowledge';
  }

  private buildRun(
    proposal: DistillProposal,
    outcome: DistillRun['outcome'],
    productIds: string[],
    extra?: { id?: string; landings?: DistillRunLandings; error?: string; attempts?: number },
  ): DistillRun {
    return {
      id: extra?.id ?? randomUUID(),
      proposalId: proposal.id,
      executedAt: new Date().toISOString(),
      outcome,
      signals: proposal.signals,
      materialIds: proposal.materialIds,
      productIds,
      attempts: extra?.attempts ?? 0,
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
