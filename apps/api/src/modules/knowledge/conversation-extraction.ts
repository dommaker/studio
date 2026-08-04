/**
 * conversation-extraction — R3 会话提取 + 提案审核闭环
 *
 * 自 knowledge-service.ts 整块抽出（纯代码移动）：会话消息 → 紧凑 transcript、
 * 单条 LLM 提取结果入库（proposal 闸门：形态门禁 → linter 阻断）、
 * 审核闭环提案卡（knowledge_proposal 卡片投放到 #系统 频道）。
 * 供 KnowledgeService.extractFromConversation 调用。
 */

import type { KnowledgeLinter, KnowledgeIngest, KnowledgeSubsystem } from '@dommaker/harness';
import { logger } from '@dommaker/studio-shared';
import { validateKnowledgeForm } from './knowledge-forms.js';
import { writeTrendData, fileStore } from './knowledge-data-layer.js';

// ── R3 会话提取 + 提案闸门 ──

/** R3: 会话提取 transcript 上限（字符）。提取输入独立度量，不占 2K 注入红线，但仍控制单次调用规模。 */
const CONVERSATION_TRANSCRIPT_MAX_CHARS = 12_000;
const CONVERSATION_MESSAGE_MAX_CHARS = 2_000;

/** LLM 提取返回的合法知识类型（越界值回落 guideline） */
const VALID_KNOWLEDGE_TYPES: ReadonlySet<string> = new Set(['model', 'decision', 'guideline', 'pitfall', 'process', 'architecture']);

/**
 * R3: 会话消息 → 紧凑 transcript（role 标注 + 截断）。
 * 单条消息 2000 字符；整体 12000 字符，超出时保留头尾、中间标记省略。
 */
function buildConversationTranscript(messages: { role: string; content: string }[]): string {
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
function ingestConversationEntry(
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

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/**
 * 审核闭环（2026-07 knowledge-review-loop）：提取产物入库后，聚合本次条目发一张
 * cardType='knowledge_proposal' 卡片到 #系统 频道。人在频道 approve → promote
 * （draft→verified，参与注入）；reject → demote（draft→archived）。
 *
 * 契约（γ 轨道依赖，不得偏离）：cardType='knowledge_proposal'；
 * cardData.entries=[{id,title,type}]；cardData.workUnitId 为来源 WorkUnit。
 * 无条目 / 频道缺失 / 发卡失败均静默跳过（提取链路绝不被通知阻断）。
 */
async function postKnowledgeProposalCard(
  entries: Array<{ id: string; title: string; type: string }>,
  ctx: { workUnitId?: string; source: string },
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const channel = (await fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return; // 频道未播种 → 静默跳过（与 auditor postToSystemChannel 同款降级）

    const { channelMessageService } = await import('../channels/channel-message.service.js');
    const content = [
      '## 📚 知识提案 — 待人工审核',
      '',
      ...entries.map((e, i) => `${i + 1}. **${e.title}**（${e.type}）`),
      '',
      `来源 WorkUnit: ${ctx.workUnitId ?? 'unknown'}`,
      '审核通过后参与知识注入；拒绝则归档，不再注入。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      content,
      'knowledge_proposal',
      { entries, workUnitId: ctx.workUnitId ?? null, source: ctx.source },
    );
    logger.info('[KnowledgeService] knowledge_proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, entryCount: entries.length, workUnitId: ctx.workUnitId,
    });
  } catch (e) {
    logger.warn('[KnowledgeService] Failed to post knowledge_proposal card', { error: String(e) });
  }
}

export { buildConversationTranscript, ingestConversationEntry, postKnowledgeProposalCard };
