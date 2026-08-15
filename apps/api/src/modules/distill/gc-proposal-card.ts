/**
 * gc-proposal-card (#144) — GC 候选清单人审卡（复用 postDistillProposalCard 模式）
 *
 * cardType='gc_proposal'，cardData 带 gcProposalId + 候选清单（每条附可读理由）；
 * approve/reject 接线见 distill.routes（POST /api/v1/distill/gc/approve|reject）。
 * 发卡失败 / 频道缺失静默跳过（返回 false，由调用方标记提案 card-failed）——
 * 同 #101/#143 降级口径，蒸馏链路绝不被通知阻断。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import type { GcProposal } from './gc-store.js';

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/**
 * 发一张 cardType='gc_proposal' 卡到 #系统 频道。
 * 返回是否成功发出；频道缺失 / 发卡失败均静默（false），不抛。
 */
export async function postGcProposalCard(
  proposal: GcProposal,
  deps: { fileStore: FileStore },
): Promise<boolean> {
  try {
    const channel = (await deps.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return false; // 频道未播种 → 静默跳过

    const { channelMessageService } = await import('../channels/channel-message.service.js');

    const content = [
      '## 🗑️ 知识库 GC 候选清单 — 待确认',
      '',
      proposal.forced
        ? `主区 ${proposal.mainAreaCount} 条已超容量上限（200），强制出清单。`
        : `按蒸馏周期计龄（连续 3 周期零引用）；主区 ${proposal.mainAreaCount} 条。`,
      '',
      `候选（${proposal.candidates.length} 条）：`,
      ...proposal.candidates.map((c, i) => `${i + 1}. **${c.title}**\n   ${c.reason}`),
      '',
      '确认后候选条目 maturity=archived 移出主区（可恢复）；拒绝则全部保留。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      content,
      'gc_proposal',
      {
        gcProposalId: proposal.id,
        runId: proposal.runId,
        candidates: proposal.candidates,
        forced: proposal.forced,
        mainAreaCount: proposal.mainAreaCount,
      },
    );
    logger.info('[Distill] gc_proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, gcProposalId: proposal.id, candidateCount: proposal.candidates.length,
    });
    return true;
  } catch (e) {
    logger.warn('[Distill] Failed to post gc_proposal card', { gcProposalId: proposal.id, error: String(e) });
    return false;
  }
}
