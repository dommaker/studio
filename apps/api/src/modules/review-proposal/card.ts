/**
 * review-proposal/card (#351) — 人审提案卡投放 #系统 频道（唯一正本）
 *
 * 自三张旧卡（distill-proposal-card/gc-proposal-card/constraint-audit-card）同构实现收敛：
 * #系统 频道解析 + 发卡投放；频道缺失 / 发卡失败静默 false 不抛——
 * 同 #101/#143 降级口径，业务链路绝不被通知阻断（由调用方落 card-failed 墓碑）。
 * 卡片内容（content/cardData/cardType）归业务方 adapter.renderCardContent，本文件只管投放。
 *
 * 发卡出口缝（Phase 5 SCC 第一刀 #3）：原动态 import channels 躲循环的临时招收敛为
 * 装配期 DI——ChannelCardPoster 注册口在本模块，bootstrap/module-sinks.ts 注入
 * channels 的 ChannelMessageService.createCardMessage 实现。
 */
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/** 发卡出口缝的一次投递（bootstrap 装配期映射到 createCardMessage） */
export interface ChannelCardPost {
  channelId: string;
  author: string;
  content: string;
  cardType: string;
  cardData: Record<string, unknown>;
}

export type ChannelCardPoster = (post: ChannelCardPost) => Promise<unknown>;

let cardPoster: ChannelCardPoster | null = null;

/** 装配期注入实现；测试可传 null 复位到未注册态 */
export function registerChannelCardPoster(fn: ChannelCardPoster | null): void {
  cardPoster = fn;
}

export interface ReviewProposalCardPayload {
  /** 前端卡片渲染键（如 distill_proposal / gc_proposal） */
  cardType: string;
  /** 卡片正文（markdown） */
  content: string;
  /** 卡片数据（approve/reject 接线所需的提案 id 与展示清单） */
  cardData: Record<string, unknown>;
  /** 日志标签（缺省 = cardType） */
  logTag?: string;
  /** 卡片作者（缺省 'KK'；业务方历史作者经此透传，如 auditor 卡 'Auditor'） */
  author?: string;
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

    if (!cardPoster) {
      // 未注册 = 装配错误，与发卡失败同口径：被下方 catch 收成 warn + false
      throw new Error('ChannelCardPoster 未注册（bootstrap 装配期应注入 channels 实现）');
    }
    await cardPoster({
      channelId: channel.id,
      author: card.author ?? 'KK',
      content: card.content,
      cardType: card.cardType,
      cardData: card.cardData,
    });
    logger.info('[ReviewProposal] proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, cardType: card.cardType, logTag,
    });
    return true;
  } catch (e) {
    logger.warn('[ReviewProposal] Failed to post proposal card', { cardType: card.cardType, logTag, error: String(e) });
    return false;
  }
}
