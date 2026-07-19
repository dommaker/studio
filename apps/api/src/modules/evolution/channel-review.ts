/**
 * E1 约束进化：频道审核（channel review）。
 *
 * 复用 F5 双向沟通精神：提案以系统作者（'Evolution'）发到 #系统 频道
 * （不存在则回退第一个可用频道；一个频道都没有 → 记日志跳过，提案仍可从 API 审核），
 * 人类在任意频道回复 `approve EP-XXXX` / `reject EP-XXXX`（可附理由）即完成决策。
 *
 * 监听点：`channel.message_sent` 事件（channelMessageService 发布，authorType='human'
 * 过滤）—— 这是消息落库后的统一观察点（message-routing 与 API 直发都会经过）。
 */
import { eventBus, logger, type FileStore, type EvolutionProposalData } from '@dommaker/studio-shared';
import { channelMessageService, type ChannelMessageService } from '../channels/channel-message.service.js';
import type { EvolutionService } from './evolution.service.js';

/** 频道内系统作者名（沿用 'Studio'/'OpsAgent' 等 agent 消息约定） */
export const EVOLUTION_AUTHOR = 'Evolution';

/** 解析人类回复：`approve EP-0001` / `reject EP-0001：理由`（大小写不敏感） */
export function parseDecisionReply(
  content: string,
): { decision: 'approve' | 'reject'; id: string; reason?: string } | null {
  const m = content.match(/\b(approve|reject)\s+(EP-\d{4,})\b\s*[：:，,]?\s*([\s\S]*)/i);
  if (!m) return null;
  const reason = (m[3] ?? '').trim();
  return {
    decision: m[1].toLowerCase() === 'approve' ? 'approve' : 'reject',
    id: m[2].toUpperCase(),
    ...(reason ? { reason } : {}),
  };
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** 提案审核消息正文 */
export function formatProposalMessage(p: EvolutionProposalData): string {
  const counts = Object.entries(p.evidence.eventCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  return [
    `[约束进化提案 ${p.id}] ${p.targetType} / ${p.targetId}（${p.action}，待审核）`,
    `当前：${truncate(p.currentText || '（空）', 160)}`,
    `提案：${truncate(p.proposedText, 160)}`,
    `理由：${truncate(p.rationale, 240)}`,
    `证据：${counts || '无'}（窗口 ${p.evidence.windowHours}h，来源 ${p.source}）`,
    `回复 approve ${p.id} 或 reject ${p.id}（可附理由）`,
  ].join('\n');
}

/** 新提案发到 #系统 频道（回退：第一个可用频道；无频道 → 记日志跳过）。返回是否已发布。 */
export async function postProposalToChannel(
  fileStore: FileStore,
  proposal: EvolutionProposalData,
  messageService: ChannelMessageService = channelMessageService,
): Promise<boolean> {
  try {
    const sys = (await fileStore.listChannels({ name: '#系统' }))[0] ?? (await fileStore.listChannels())[0];
    if (!sys) {
      logger.warn('[Evolution] No channel available, skip posting proposal', { id: proposal.id });
      return false;
    }
    await messageService.createAgentMessage(sys.id, EVOLUTION_AUTHOR, formatProposalMessage(proposal), {
      meta: { evolutionProposalId: proposal.id },
    });
    return true;
  } catch (err) {
    logger.warn('[Evolution] Failed to post proposal to channel', { id: proposal.id, error: String(err) });
    return false;
  }
}

interface MessageSentPayload {
  channelId: string;
  message: { id: string; authorType: string; content: string };
}

/**
 * 订阅人类回复完成审核。返回退订函数。
 * 幂等：已决策提案再收到 approve/reject → 回帖说明并忽略。
 */
export function initEvolutionChannelReview(
  service: EvolutionService,
  messageService: ChannelMessageService = channelMessageService,
): () => void {
  const handler = async (payload: MessageSentPayload) => {
    try {
      const msg = payload?.message;
      if (!msg || msg.authorType !== 'human' || typeof msg.content !== 'string') return;
      const parsed = parseDecisionReply(msg.content);
      if (!parsed) return;
      const channelId = payload.channelId;
      const reply = (content: string) =>
        messageService.createAgentMessage(channelId, EVOLUTION_AUTHOR, content, { replyToId: msg.id }).catch(() => {});

      const existing = await service.get(parsed.id);
      if (!existing) {
        await reply(`未找到提案 ${parsed.id}。可通过 GET /api/v1/evolution/proposals 查看待审核提案。`);
        return;
      }
      try {
        const decided = await service.decide(parsed.id, parsed.decision, { decidedBy: 'channel', reason: parsed.reason });
        if (parsed.decision === 'approve') {
          await reply(`${decided.id} 已批准并生效（${decided.targetType} / ${decided.targetId}，appliedAt ${decided.appliedAt}）`);
        } else {
          await reply(`${decided.id} 已拒绝${parsed.reason ? `（理由：${parsed.reason}）` : ''}。`);
        }
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e?.code === 'CONFLICT') {
          await reply(`${parsed.id} 已是 ${existing.status} 状态，本次 ${parsed.decision} 已忽略。`);
        } else if (e?.code === 'APPLY_FAILED') {
          await reply(`${parsed.id} 已批准但生效失败：${e?.message ?? 'unknown'}。修复后可再次回复 approve ${parsed.id} 重试。`);
        } else {
          await reply(`${parsed.id} 处理失败：${e?.message ?? String(err)}`);
        }
      }
    } catch (err) {
      logger.warn('[Evolution] channel review handler failed', { error: String(err) });
    }
  };
  eventBus.subscribe('channel.message_sent', handler);
  return () => eventBus.unsubscribe('channel.message_sent', handler);
}
