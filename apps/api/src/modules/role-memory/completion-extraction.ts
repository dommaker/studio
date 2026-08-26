/**
 * completion-extraction (#99) — WU 收尾批量提取钩子
 *
 * 挂在 WU 状态机收尾钩子（workunit.status_changed → done）上：一次 LLM 调用读完整
 * transcript（归档器 readTranscript 输出，非逐步埋点），把执行知识/教训产出为角色
 * 记忆草稿区条目（roleMemoryStore.appendDraft）。可审计（knowledge:extraction 事件）、
 * 可熔断（daily-token-budget 守卫）。失败绝不阻塞 WU 收尾（fire-and-forget + catch 记日志）。
 *
 * 与旧 R3 会话提取（agent-loop COMPLETE 步 → KnowledgeService.extractFromConversation，
 * proposal 入库 KnowledgeStore）并行独立：#99 只加新钩子，不动旧路径；旧路径及其触发器
 * 删除归 #102。去重哨兵用 metadata.memoryExtractedAt（区别于旧路径 knowledgeExtractedAt）。
 *
 * 事件订阅语义与 ReviewDispatcher / AnalysisHandoff 一致（eventBus 进程内，best-effort）。
 */

import { eventBus, logger, FileStore } from '@dommaker/studio-shared';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { WorkUnitService, type WorkUnitData } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { readTranscript, type TranscriptEntry } from '../transcripts/transcript-archive.js';
import { roleMemoryStore } from './role-memory.js';
import type { AppendDraftInput, MemoryDraftEntry } from './role-memory.js';
import { registerMemoryReviewAdapter, submitMemoryProposal } from './review-adapter.js';
import { getSystemExecutor, StudioRoleNotConfiguredError } from '../agents/system-executor.js';
import {
  tokenBudgetGuardEnabled,
  resolveDailyTokenBudget,
  getDailyTokenUsage,
} from '../agents/loop/daily-token-budget.js';

/**
 * 角色记忆提取 prompt（单一来源，适配 appendDraft 产出）：只收 execution-knowledge /
 * preference 两类；产出解析为 appendDraft 的 kind/title/content/topicSlug。
 * 与旧 R3 会话提取的 EXTRACT_FROM_TEXT_SYSTEM_PROMPT（产出 KnowledgeStore proposal）分开，
 * 不共用——两处产出目标不同（角色记忆草稿 vs 项目级知识提案）。
 */
export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `你是角色记忆提取专家。从给定执行 transcript 中提取值得沉淀进该角色长期记忆的经验条目。

角色记忆只收两类，其余（架构/项目级决策、persona/职责）一律不提取：
- execution-knowledge：有效做法 / 踩坑 / 失败教训。每条必须写清 ①根因（非表面现象）②责任（哪个环节该预防）③预防（具体可操作）。
- preference：该角色的偏好 / 约定（如代码风格、工作流习惯）。

每条需判定人审档位 review：
- "auto"：操作型事实，高置信、零争议（如测试命令 / 路径 / 既定流程），可直接进记忆无需人审；
- "manual"：规律 / 教训 / 偏好（需人工把关），走人审卡片。

输出 JSON（不要 markdown 包裹）：
{ "entries": [ { "kind": "execution-knowledge" | "preference", "title": "一句话概括", "content": "正文（execution-knowledge 写根因+责任+预防；preference 写约定原文）", "topicSlug": "可选，英文短横线 slug，缺省由 title 推导", "review": "\"auto\" | \"manual\"（缺省 manual）" } ] }

只提取有复用价值、值得沉淀的；没有则返回空数组；最多 5 条。`;

/** 单次提取 transcript 输入上限（字符）——独立度量不计入注入红线，但仍控制单次调用规模（与 R3 同口径） */
const TRANSCRIPT_MAX_CHARS = 12_000;

/** 提取最多产出条目数（与 R3 会话提取同口径） */
const MAX_ENTRIES = 5;

/** WU 收尾提取的事件文件（同 agent-loop 口径：STUDIO_EVENTS_JSONL 覆盖 / resolveStudioLogFile 兜底，测试可隔离） */
function studioEventsJsonlPath(): string {
  return process.env.STUDIO_EVENTS_JSONL || resolveStudioLogFile('studio-events.jsonl');
}

/**
 * 归档器 transcript → 提取输入文本：rawOutput 逐行拼接（step/action 标注），
 * 超出上限保留头尾、中间标记省略（照 conversation-extractor.buildConversationTranscript 口径）。
 */
export function buildTranscriptText(entries: TranscriptEntry[]): string {
  const lines = (entries || [])
    .filter(e => typeof e.rawOutput === 'string' && e.rawOutput.trim().length > 0)
    .map(e => `[step ${e.step}${e.action ? `/${e.action}` : ''}] ${e.rawOutput!.trim()}`);
  const full = lines.join('\n\n');
  if (full.length <= TRANSCRIPT_MAX_CHARS) return full;
  const head = full.slice(0, 4_000);
  const tail = full.slice(-(TRANSCRIPT_MAX_CHARS - 4_000));
  return `${head}\n\n...[truncated ${full.length - TRANSCRIPT_MAX_CHARS} chars]...\n\n${tail}`;
}

/**
 * LLM 产出条目 → appendDraft 入参。kind 白名单外回落 execution-knowledge（记忆只收两类，
 * 白名单由 appendDraft 最终把关）；review 白名单外回落 manual（缺省 manual）；
 * 缺 title/content 返回 null（丢弃，不写空条目）。
 */
export function normalizeDraftInput(raw: {
  kind?: string;
  title?: string;
  content?: string;
  topicSlug?: string;
  review?: string;
}): AppendDraftInput | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!title || !content) return null;
  const kind = raw.kind === 'preference' ? 'preference' : 'execution-knowledge';
  const topicSlug = typeof raw.topicSlug === 'string' ? raw.topicSlug.trim() : '';
  const review = raw.review === 'auto' ? 'auto' : 'manual';
  return {
    kind,
    title,
    content,
    review,
    ...(topicSlug ? { topicSlug } : {}),
  };
}

export class WuCompletionExtractor {
  private subscribed = false;

  constructor(
    private fileStore: FileStore,
    private workUnitService: WorkUnitService,
    private eventsFile: string = studioEventsJsonlPath(),
  ) {}

  /** 订阅 workunit.status_changed。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done') return;
      // fire-and-forget：LLM 提取（30s 级）绝不能在事件循环里 await 阻断收尾订阅链
      void this.maybeExtract(wu).catch(err =>
        logger.warn('[WuCompletionExtractor] maybeExtract failed (non-blocking)', { wuId: wu.id, error: String(err) }),
      );
    });
  }

  /**
   * 收尾提取入口（供事件订阅与测试直接调用）：守卫（去重哨兵 / roleId / 预算熔断）→
   * 落哨兵 → 提取 + 写草稿 + 审计事件。永不抛：所有失败在内部 catch 记日志 + 落事件。
   */
  async maybeExtract(wu: WorkUnitData): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——幂等判定必须以库存最新状态为准（同 analysis-handoff）
    const fresh = await this.workUnitService.getById(wu.id);
    if (!fresh) return;
    const meta = parseWuMetadata(fresh.metadata);
    if (meta.memoryExtractedAt) return; // 已提取（去重哨兵）

    // 角色 id：assigneeId 双语义（profile id 直通 / instance id → state.roleId）
    const roleId = await this.resolveRoleId(fresh.assigneeId);
    if (!roleId) {
      logger.info('[WuCompletionExtractor] skip: no role id', { wuId: fresh.id });
      await this.emitEvent({ outcome: 'skipped', reason: 'no-role-id', workUnitId: fresh.id });
      return;
    }

    // 熔断：每日 token 预算超限 → 跳过提取（可观测，不阻塞收尾；不落哨兵，次日预算复位可重试）
    if (await this.isBudgetExhausted()) {
      logger.warn('[WuCompletionExtractor] skip: daily token budget exhausted', { wuId: fresh.id, roleId });
      await this.emitEvent({ outcome: 'skipped', reason: 'budget-exhausted', workUnitId: fresh.id, roleId });
      return;
    }

    // 去重哨兵先落档（即便后续提取失败也不重复触发；与 analysis-handoff 哨兵同语义）。
    // 写入前重读合并最新 metadata——本钩子与 map-opening/analysis-handoff/spec-materialization
    // 同一 done 事件并发写同一 WU metadata，读-改-写互覆会丢其它订阅方的哨兵字段（#115 e2e 先例）。
    const latest = await this.workUnitService.getById(fresh.id);
    const latestMeta = latest ? parseWuMetadata(latest.metadata) : meta;
    if (latestMeta.memoryExtractedAt) return; // 重读后哨兵已落（并发/重发）
    await this.workUnitService.update(fresh.id, {
      metadata: { ...latestMeta, memoryExtractedAt: new Date().toISOString() },
    });

    await this.extractAndDraft(fresh, roleId);
  }

  /** assigneeId → profile id（roleId）：getProfile 命中即 profile id；否则 state.roleId（同 review-dispatcher 单 WU 口径） */
  private async resolveRoleId(assigneeId: string | null): Promise<string | null> {
    if (!assigneeId) return null;
    if (await this.fileStore.getProfile(assigneeId)) return assigneeId;
    const state = await this.fileStore.getState(assigneeId).catch(() => null);
    return state?.roleId ?? null;
  }

  /** 每日 token 预算熔断判定：守卫关闭 / 预算 <=0 → 不熔断；当日已耗 ≥ 预算 → true */
  private async isBudgetExhausted(): Promise<boolean> {
    if (!tokenBudgetGuardEnabled()) return false;
    const budget = resolveDailyTokenBudget();
    if (budget <= 0) return false;
    const daily = await getDailyTokenUsage({ eventsFile: this.eventsFile });
    return daily.usedTokens >= budget;
  }

  /**
   * 读完整 transcript → 一次 LLM 调用 → 解析条目 → appendDraft 写草稿 → 落审计事件。
   * 失败 catch 记日志 + 落 failed 事件，绝不抛给收尾主流程。
   */
  private async extractAndDraft(wu: WorkUnitData, roleId: string): Promise<void> {
    const startMs = Date.now();
    try {
      const transcript = buildTranscriptText(await readTranscript(wu.id));
      if (!transcript) {
        logger.info('[WuCompletionExtractor] skip: empty transcript', { wuId: wu.id, roleId });
        await this.emitEvent({ outcome: 'skipped', reason: 'empty-transcript', workUnitId: wu.id, roleId, durationMs: Date.now() - startMs });
        return;
      }

      const execResult = await getSystemExecutor().run(transcript, {
        systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
        eventSource: 'wu-completion-extraction',
      });
      const durationMs = Date.now() - startMs;
      const promptTokens = execResult.usage?.inputTokens ?? 0;
      const completionTokens = execResult.usage?.outputTokens ?? 0;
      const totalTokens = promptTokens + completionTokens;

      const parsed = JSON.parse(execResult.output) as {
        entries?: Array<{ kind?: string; title?: string; content?: string; topicSlug?: string; review?: string }>;
      };
      const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries.slice(0, MAX_ENTRIES) : [];

      // 两档路由（#101）：auto=操作型事实直接落草稿并 promote 进索引（不产卡）；
      // manual=规律/教训/偏好经 review-proposal 正本发卡人审（#353：submitMemoryProposal
      // 逐条落 draft.jsonl（条目行即提案行）+ 聚合一张 memory_proposal 卡；approve→promote / reject→demote）。
      const auto: MemoryDraftEntry[] = [];
      const manualInputs: AppendDraftInput[] = [];
      for (const raw of rawEntries) {
        const input = normalizeDraftInput(raw);
        if (!input) continue;
        if (input.review === 'auto') auto.push(await roleMemoryStore.appendDraft(roleId, input));
        else manualInputs.push(input);
      }

      if (auto.length > 0) {
        await roleMemoryStore.promote(roleId, auto.map(e => e.id));
      }
      const manual = manualInputs.length > 0
        ? await submitMemoryProposal(roleId, manualInputs, { workUnitId: wu.id, source: 'wu-completion' })
        : [];
      const entryCount = auto.length + manual.length;

      logger.info('[WuCompletionExtractor] extraction completed', {
        wuId: wu.id, roleId, entryCount, autoCount: auto.length, manualCount: manual.length, totalTokens, durationMs,
      });
      await this.emitEvent({
        outcome: 'completed',
        workUnitId: wu.id,
        roleId,
        entryCount,
        autoCount: auto.length,
        manualCount: manual.length,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
      });
    } catch (err) {
      if (err instanceof StudioRoleNotConfiguredError) {
        logger.info('[WuCompletionExtractor] extraction skipped: studio role provider not configured', { wuId: wu.id, roleId });
        await this.emitEvent({ outcome: 'skipped', reason: 'studio-role-not-configured', workUnitId: wu.id, roleId, durationMs: Date.now() - startMs });
        return;
      }
      logger.warn('[WuCompletionExtractor] extraction failed (non-blocking)', { wuId: wu.id, roleId, error: String(err) });
      await this.emitEvent({
        outcome: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        workUnitId: wu.id,
        roleId,
        durationMs: Date.now() - startMs,
      });
    }
  }

  /** 落 knowledge:extraction 审计事件（成功/跳过/失败统一走此接缝；写盘失败仅记日志，不抛） */
  private async emitEvent(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.fileStore.appendJsonl(this.eventsFile, {
        type: 'knowledge:extraction',
        source: `wu-completion:${payload.workUnitId ?? 'unknown'}`,
        payload: JSON.stringify({ trigger: 'wu-completion', ...payload }),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('[WuCompletionExtractor] failed to persist knowledge:extraction event', { error: String(err) });
    }
  }
}

// 单例（懒初始化，形态同 AnalysisHandoff）
let _extractor: WuCompletionExtractor | null = null;

export function initWuCompletionExtraction(fileStore?: FileStore): WuCompletionExtractor {
  if (!_extractor) {
    const fs = fileStore ?? new FileStore();
    _extractor = new WuCompletionExtractor(fs, new WorkUnitService(fs));
  }
  _extractor.subscribeToEvents();
  // #353：memory 人审提案 adapter 注册（review-proposal 正本通用端点 kind='memory' 分发前提）
  registerMemoryReviewAdapter({ fileStore });
  return _extractor;
}
