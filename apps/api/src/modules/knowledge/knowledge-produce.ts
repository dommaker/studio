/**
 * knowledge-produce — Produce 能力实现（write knowledge：extract / record）
 *
 * 自 knowledge-service.ts 整块抽出（#669 刀2，纯代码移动不改行为）：
 * KnowledgeService.extractFromExecution / extractFromConversation / recordPattern /
 * recordIncident / recordTrend / recordAnalystAccuracy 的实现体。
 * 模块级函数（不占 KnowledgeService prototype 方法数，knowledge-service.test.ts 锁定 33），
 * 门面方法为薄封装。
 */

import { logger } from '@dommaker/studio-shared';
// P2-c 拆环：getSystemExecutor/StudioRoleNotConfiguredError 改函数内动态 import（见 extractFromConversationImpl）
import { resolveStudioEventsFile } from '@dommaker/studio-shared';
import { getStore } from '../../core/store.js';
import { ENTRY_TYPE_MAP } from './knowledge-types.js';
import type {
  KnowledgeServiceDeps,
  ExtractionResult,
  ConversationExtractionCtx,
  PatternEntry,
  IncidentEntry,
  TrendEntry,
  AnalystAccuracyInput,
} from './knowledge-types.js';
import { scheduleVectorDbSync, ingestWithQualityGate } from './knowledge-singletons.js';
import { writeTrendData } from './trend-data.js';
import { buildConversationTranscript, ingestConversationEntry } from './conversation-extractor.js';
import { submitKnowledgeProposal } from './review-adapter.js';
import { recordConsumptionImpl } from './knowledge-track.js';

export async function extractFromExecutionImpl(deps: KnowledgeServiceDeps, result: ExtractionResult): Promise<void> {
  // Extract knowledge patterns from execution diff/task
  if (!result.diff && !result.task) return;

  const title = `[Exec] ${result.agentType}: ${result.task.slice(0, 80)}`;
  const content = [
    `Agent: ${result.agentType}`,
    `Success: ${result.success}`,
    `Duration: ${result.duration}ms`,
    result.diff ? `Diff (${result.diff.length} chars): ${result.diff.slice(0, 500)}` : '',
    result.consumedKnowledge.length > 0 ? `Consumed: ${result.consumedKnowledge.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // AC-3.1: Failure → mark for review with need_review tag
  const tags = ['execution', result.agentType];
  if (!result.success) {
    tags.push('need_review');
  }

  // AC-3.3: Dedup — check if existing published entry on same topic exists
  const allEntries = deps.store.list({});
  const existingSameTopic = allEntries.find((e: any) =>
    e.title && e.title.startsWith(`[Exec] ${result.agentType}:`) &&
    e.title.includes(result.task.slice(0, 40))
  );

  if (existingSameTopic) {
    // Merge: update existing entry with new content
    const mergedContent = `${existingSameTopic.content}\n\n---\n${content}`;
    const updatedRefs = [
      ...(existingSameTopic.sourceReferences || []),
      { source: `execution:${result.agentType}`, timestamp: new Date().toISOString() },
    ];
    deps.store.save({ ...existingSameTopic, content: mergedContent, sourceReferences: updatedRefs.slice(-20) });
  } else {
    await recordPatternImpl(deps, {
      type: result.success ? 'pattern' : 'failure',
      title,
      content,
      tags,
    });
  }

  // Record outcome for consumed knowledge entries
  if (result.consumedKnowledge.length > 0) {
    recordConsumptionImpl(deps, result.consumedKnowledge, `execution:${result.agentType}`);
  }

  deps.eventEmitter.emit('knowledge', { type: 'extractFromExecution', data: { agentType: result.agentType, success: result.success } });

  // B59-002: persist to StudioEvent for OKR queryKnowledgeQualityGatePassRate
  try {
    await getStore().appendJsonl(resolveStudioEventsFile(), {
      type: 'extractFromExecution',
      payload: JSON.stringify({ agentType: result.agentType, success: result.success }),
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn('[KnowledgeService] Failed to persist extractFromExecution event', { error: String(e) });
  }
}

/**
 * R3 会话提取（断点 B）：任务 COMPLETE 时由 agent-loop 触发一次 LLM 提取
 * （根因/模式/可复用经验），结果以 proposal（maturity=draft）入库。
 *
 * - LLM 路径复用 KnowledgeCurator 的提取链路：systemExecutor.run +
 *   getExtractFromTextSystemPrompt()（单一 prompt 来源，不复制；E1 支持
 *   ~/.studio/prompt-overrides/knowledge.extract-from-text.md 文件覆盖）。
 * - proposal 须经审核（promote → verified）才参与注入（见 injectContext 的
 *   isInjectableMaturity 闸门）；模板式 extractFromExecution 保留为兜底。
 * - 提取开销（tokens/duration）以 knowledge:extraction 事件单独度量，
 *   不计入注入红线。
 * - 永不抛出：LLM 未配置/调用失败仅记日志（e2e 无 LLM 时静默跳过）。
 * - P8（2026-09-16 perf 实测）：总开关 `STUDIO_KNOWLEDGE_EXTRACTION=false`
 *   整体跳过——无凭证/fake-provider 环境里 studio 角色 provider 仍指向真实
 *   CLI，每次 WU 完成都起真实 LLM 进程挂到超时，纯空转+日志噪声。
 */
export async function extractFromConversationImpl(
  deps: KnowledgeServiceDeps,
  messages: { role: string; content: string }[],
  ctx?: ConversationExtractionCtx,
): Promise<void> {
  const source = ctx?.source ?? `conversation:${ctx?.workUnitId ?? 'unknown'}`;
  if (process.env.STUDIO_KNOWLEDGE_EXTRACTION === 'false') {
    logger.info('[KnowledgeService] extractFromConversation skipped: STUDIO_KNOWLEDGE_EXTRACTION=false', { source });
    return;
  }
  // P2-c 拆环：knowledge→agents 静态边转函数内动态 import（置于 try 外，catch 的 instanceof 也要用）
  // P2-d 刀7：getExtractFromTextSystemPrompt 随知识维护 Agent 迁 agent-knowledge
  const { getExtractFromTextSystemPrompt } = await import('../agent-knowledge/index.js');
  const { getSystemExecutor, StudioRoleNotConfiguredError } = await import('../agents/index.js');
  try {
    const transcript = buildConversationTranscript(messages);
    if (!transcript) return;

    // 复用 KnowledgeCurator 的提取 prompt（动态 import 避免静态循环依赖：
    // knowledge-curator.service 已静态引用本模块的 validateKnowledgeForm/writeTrendData）
    // E1: 经 getter 取值以支持 prompt-override 文件覆盖（约束进化提案生效路径）

    const startMs = Date.now();
    const execResult = await getSystemExecutor().run(transcript, {
      systemPrompt: getExtractFromTextSystemPrompt(),
      eventSource: 'conversation-extraction',
    });
    const durationMs = Date.now() - startMs;
    const result = JSON.parse(execResult.output) as { entries?: Array<{ type?: string; title?: string; content?: string; tags?: string[] }> };

    // 提取开销：systemExecutor.run 返回的 usage（CLI --output-format json envelope）
    const promptTokens = execResult.usage?.inputTokens ?? 0;
    const completionTokens = execResult.usage?.outputTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    const entries = Array.isArray(result?.entries) ? result.entries.slice(0, 5) : [];
    const ingested: Array<{ id: string; title: string; type: string }> = [];
    for (const raw of entries) {
      const saved = ingestConversationEntry({ ingest: deps.ingest }, raw, source);
      if (saved) ingested.push(saved);
    }
    const entryIds = ingested.map(e => e.id);
    if (ingested.length > 0) {
      scheduleVectorDbSync();
      // 审核闭环：入库即建提案发审核卡到 #系统（#355 起走 review-proposal 正本，
      // 人在频道 approve/reject → 通用端点 → adapter onApprove/onReject → promote/demote）。
      // best-effort：频道缺失/发卡失败落 card-failed 墓碑静默跳过，绝不阻断提取链路。
      await submitKnowledgeProposal(ingested, { workUnitId: ctx?.workUnitId, source });
    }

    logger.info('[KnowledgeService] extractFromConversation completed', {
      source, entryCount: entryIds.length, totalTokens, durationMs,
    });

    // M2 成本度量：提取开销单独记事件，与注入 tokens 分开核算
    const eventData = {
      trigger: 'task-complete',
      workUnitId: ctx?.workUnitId,
      entryIds,
      entryCount: entryIds.length,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
    };
    deps.eventEmitter.emit('knowledge', { type: 'extractFromConversation', data: eventData });
    try {
      await getStore().appendJsonl(resolveStudioEventsFile(), {
        type: 'knowledge:extraction',
        source,
        payload: JSON.stringify(eventData),
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn('[KnowledgeService] Failed to persist knowledge:extraction event', { error: String(e) });
    }
  } catch (err) {
    if (err instanceof StudioRoleNotConfiguredError) {
      logger.info('[KnowledgeService] extractFromConversation skipped: studio role provider not configured', { source });
      return;
    }
    // 提取失败绝不影响任务完成（模板兜底仍由 extractFromExecution 独立承担）
    logger.warn('[KnowledgeService] extractFromConversation failed', { source, error: String(err) });
  }
}

export async function recordPatternImpl(deps: KnowledgeServiceDeps, entry: PatternEntry): Promise<void> {
  try {
    const source = entry.tags?.[0] || 'monitor';

    // Merge input tags (e.g., need_review) with type-derived tags
    const tags: string[] = [entry.type, ...(entry.tags || []).filter(t => t !== entry.type)];
    const knowledgeType = ENTRY_TYPE_MAP[entry.type] || 'guideline';

    // R4: 统一质量门（断点 H）— 与 KnowledgeBus.recordPattern 单一路径。
    // triage 业务门 + harness ingest 门（reject 跳过 / flag 自动 low_quality）
    // 均在 ingestWithQualityGate 内处理；studio 侧不再另起 linter 预检。
    ingestWithQualityGate(
      { ingest: deps.ingest },
      {
        type: knowledgeType,
        title: entry.title,
        content: entry.content,
        tags,
        source,
        entryType: entry.type,
        layer: 'project',
        maturity: 'active',
        consumptionMode: 'signal',
        origin: entry.origin ?? 'system',
      },
    );
  } catch {
    // best-effort — don't block producers
  }
}

export async function recordIncidentImpl(deps: KnowledgeServiceDeps, entry: IncidentEntry): Promise<void> {
  try {
    deps.ingest.ingestEntry(
      {
        type: 'pitfall',
        title: entry.title,
        content: entry.content,
        tags: ['incident', entry.severity],
      },
      {
        source: `incident:ops:${new Date().toISOString()}`,
        layer: 'tech',
        maturity: 'active',
        tags: ['incident', entry.severity],
        consumptionMode: 'signal',
        origin: 'system',
      },
    );
    scheduleVectorDbSync();
  } catch {
    // best-effort
  }
}

export async function recordTrendImpl(_deps: KnowledgeServiceDeps, entry: TrendEntry): Promise<void> {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const content = `## ${entry.title}\n\n${entry.content}\n\nmetric: ${entry.metric}`;
    writeTrendData(`${dateStr}.md`, content);
    logger.debug('[KnowledgeService] recordTrend → data/', { metric: entry.metric });
  } catch (e) {
    logger.warn('[KnowledgeService] recordTrend failed', { error: String(e) });
  }
}

export async function recordAnalystAccuracyImpl(_deps: KnowledgeServiceDeps, data: AnalystAccuracyInput): Promise<void> {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const missedFiles = data.predictedFiles.filter(f => !data.actualFiles.includes(f));
    const extraFiles = data.actualFiles.filter(f => !data.predictedFiles.includes(f));
    const missedDeps = data.predictedDeps.filter(d => !data.actualDeps.includes(d));

    const content = [
      `## AnalystAccuracy: ${data.goalTitle.slice(0, 80)}`,
      ``,
      `- AC匹配率: ${Math.round(data.acMatchRate * 100)}%`,
      `- 预测文件: [${data.predictedFiles.join(', ')}]`,
      `- 实际文件: [${data.actualFiles.join(', ')}]`,
      missedFiles.length > 0 ? `- 漏预测: [${missedFiles.join(', ')}]` : '',
      extraFiles.length > 0 ? `- 多预测: [${extraFiles.join(', ')}]` : '',
      missedDeps.length > 0 ? `- 漏依赖: [${missedDeps.join(', ')}]` : '',
    ].filter(Boolean).join('\n');

    writeTrendData(`${dateStr}.md`, content);
    logger.debug('[KnowledgeService] recordAnalystAccuracy → data/');
  } catch (e) {
    logger.warn('[KnowledgeService] recordAnalystAccuracy failed', { error: String(e) });
  }
}
