/**
 * review-proposal/card (#351) — 人审提案卡投放 #系统 频道（唯一正本）
 *
 * 自三张旧卡（distill-proposal-card/gc-proposal-card/constraint-audit-card）同构实现收敛：
 * #系统 频道解析 + createCardMessage 投放；频道缺失 / 发卡失败静默 false 不抛——
 * 同 #101/#143 降级口径，业务链路绝不被通知阻断（由调用方落 card-failed 墓碑）。
 * 卡片内容（content/cardData/cardType）归业务方 adapter.renderCardContent，本文件只管投放。
 */
import { FileStore, logger } from '@dommaker/studio-shared';

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

export interface ReviewProposalCardPayload {
  /** 前端卡片渲染键（如 distill_proposal / gc_proposal / constraint_audit_proposal） */
  cardType: string;
  /** 卡片正文（markdown） */
  content: string;
  /** 卡片数据（approve/reject 接线所需的提案 id 与展示清单） */
  cardData: Record<string, unknown>;
  /** 日志标签（缺省 = cardType） */
  logTag?: string;
}

/**
 * 发一张人审提案卡到 #系统 频道。
 * 返回是否成功发出；频道缺失 / 发卡失败均静默（false），不抛。
 */
export async function postReviewProposalCard(
  card: ReviewProposalCardPayload,
  deps: { fileStore: FileStore },
): Promise<boolean> {
  const logTag = card.logTag ?? card.cardType;
  try {
    const channel = (await deps.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return false; // 频道未播种 → 静默跳过

    const { channelMessageService } = await import('../channels/channel-message.service.js');
    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      card.content,
      card.cardType,
      card.cardData,
    );
    logger.info('[ReviewProposal] proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, cardType: card.cardType, logTag,
    });
    return true;
  } catch (e) {
    logger.warn('[ReviewProposal] Failed to post proposal card', { cardType: card.cardType, logTag, error: String(e) });
    return false;
  }
}
