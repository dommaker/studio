/**
 * conversation-extractor — R3 会话提取管道。
 *
 * 从 knowledge-service.ts 抽出（工单 29，纯搬运不改逻辑）：
 * - buildConversationTranscript：会话消息 → 紧凑 transcript
 * - ingestConversationEntry：单条 LLM 提取结果过形态门禁/质量门入库（proposal）
 *
 * 均由 KnowledgeService.extractFromConversation 编排调用；deps 已参数化，
 * 不依赖 KnowledgeService 实例。
 * （审核闭环提案卡 #355 起归 review-adapter.ts → review-proposal 正本，本文件不再发卡。）
 */

import type { KnowledgeLinter, KnowledgeIngest, KnowledgeSubsystem } from '@dommaker/harness';
import { logger } from '@dommaker/studio-shared';
import { validateKnowledgeForm } from './knowledge-form-gate.js';
import { writeTrendData } from './trend-data.js';

/** R3: 会话提取 transcript 上限（字符）。提取输入独立度量，不占 2K 注入红线，但仍控制单次调用规模。 */
const CONVERSATION_TRANSCRIPT_MAX_CHARS = 12_000;
const CONVERSATION_MESSAGE_MAX_CHARS = 2_000;

/** LLM 提取返回的合法知识类型（越界值回落 guideline） */
const VALID_KNOWLEDGE_TYPES: ReadonlySet<string> = new Set(['model', 'decision', 'guideline', 'pitfall', 'process', 'architecture']);

/**
 * R3: 会话消息 → 紧凑 transcript（role 标注 + 截断）。
 * 单条消息 2000 字符；整体 12000 字符，超出时保留头尾、中间标记省略。
 */
export function buildConversationTranscript(messages: { role: string; content: string }[]): string {
  const lines = (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .map(m => `[${m.role || 'unknown'}] ${m.content.trim().slice(0, CONVERSATION_MESSAGE_MAX_CHARS)}`);
  const full = lines.join('\n\n');
  if (full.length <= CONVERSATION_TRANSCRIPT_MAX_CHARS) return full;
  const head = full.slice(0, 4_000);
  const tail = full.slice(-(CONVERSATION_TRANSCRIPT_MAX_CHARS - 4_000));
  return `${head}\n\n...[truncated ${full.length - CONVERSATION_TRANSCRIPT_MAX_CHARS} chars]...\n\n${tail}`;
}

/**
 * R3: 单条 LLM 提取结果入库（proposal）。质量门：形态门禁（数据形态重定向 trends）→
 * linter 阻断跳过。maturity 恒为 draft（proposal），
 * 审核 promote 前不参与注入。返回入库条目 id；被门禁跳过/拒绝时返回 null。
 *
 * R1（type-repair）：type='decision' 条目补 tags ['decision', <category>] ——
 * category 取 LLM 产出的首个非 'decision' tag，缺省回落 'process'。
 * 决策链查询（decision-chain-extractor）以此 tag 约定为口径。
 *
 * 返回入库条目 {id,title,type}（提案卡聚合用）；被门禁跳过/拒绝时返回 null。
 */
export function ingestConversationEntry(
  deps: { linter: KnowledgeLinter; ingest: KnowledgeIngest },
  raw: { type?: string; title?: string; content?: string; tags?: string[] },
  source: string,
): { id: string; title: string; type: string } | null {
  try {
    const title = (raw.title || '').trim();
    const content = (raw.content || '').trim();
    if (!title || !content) return null;
    const rawTags = Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') : [];
    const type = (VALID_KNOWLEDGE_TYPES.has(raw.type ?? '') ? raw.type : 'guideline') as KnowledgeSubsystem;

    // R1: decision 条目统一 tags 契约 ['decision', <category>]（前两位恒定）
    let tags = rawTags;
    if (type === 'decision') {
      const category = rawTags.find(t => t !== 'decision') ?? 'process';
      tags = ['decision', category, ...rawTags.filter(t => t !== 'decision' && t !== category)];
    }

    // 形态门禁：非知识形态不入库；数据形态重定向到 trends
    const formResult = validateKnowledgeForm({ type, content, tags });
    if (!formResult.valid) {
      logger.info('[KnowledgeService] Conversation entry form-gate rejected', {
        form: formResult.form, reason: formResult.reason, title: title.slice(0, 50),
      });
      if (formResult.form === 'data') {
        const dateStr = new Date().toISOString().split('T')[0];
        writeTrendData(`${dateStr}-extracted.md`, `## ${title}\n\n${content}\n\nsource: ${source}`);
      }
      return null;
    }

    const issues = deps.linter.validateEntry({ title, content, tags, type });
    const blockers = issues.filter((i: any) => i.severity === 'high');
    if (blockers.length > 0) {
      logger.warn('[KnowledgeService] Conversation entry rejected by quality gate', {
        title: title.slice(0, 50), issues: blockers.map((i: any) => i.description),
      });
      return null;
    }

    const saved = deps.ingest.ingestEntry(
      { type, title, content, tags },
      {
        source,
        layer: 'project',
        maturity: 'draft', // R3: proposal — 审核前不参与注入
        tags,
        consumptionMode: 'signal',
        origin: 'agent',
      },
    );
    if ((saved as any)?.__rejected) return null;
    const id = (saved as any)?.id;
    return typeof id === 'string' && id ? { id, title, type } : null;
  } catch (e) {
    logger.warn('[KnowledgeService] Failed to ingest conversation entry', { error: String(e) });
    return null;
  }
}
