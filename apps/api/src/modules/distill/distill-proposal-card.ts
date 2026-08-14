/**
 * distill-proposal-card (#143) — 蒸馏提案人审卡（复用 postMemoryProposalCard 模式）
 *
 * cardType='distill_proposal'，cardData 带 proposalId + 原料清单 + 命中信号；
 * approve/reject 接线见 distill.routes（POST /api/v1/distill/approve|reject）。
 * 发卡失败 / 频道缺失静默跳过（返回 false，由调用方标记提案 card-failed），
 * 蒸馏链路绝不被通知阻断——同 #101 降级口径。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import type { DistillProposal } from './distill-store.js';

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/**
 * 发一张 cardType='distill_proposal' 卡到 #系统 频道。
 * 返回是否成功发出；频道缺失 / 发卡失败均静默（false），不抛。
 */
export async function postDistillProposalCard(
  proposal: DistillProposal,
  deps: { fileStore: FileStore },
): Promise<boolean> {
  try {
    const channel = (await deps.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return false; // 频道未播种 → 静默跳过

    const { channelMessageService } = await import('../channels/channel-message.service.js');

    const signalParts: string[] = [];
    if (proposal.signals.topicTags.length > 0) {
      signalParts.push(`同 topic/tag 新条目 ≥3（${proposal.signals.topicTags.join('、')}）`);
    }
    if (proposal.signals.manualCount > 0) {
      signalParts.push(`manual 过审新条目 ${proposal.signals.manualCount} 条`);
    }

    const content = [
      '## 🧪 知识蒸馏提案 — 待确认',
      '',
      `命中信号：${signalParts.join('；') || '—'}`,
      '',
      `原料（${proposal.materials.length} 条）：`,
      ...proposal.materials.map((m, i) => `${i + 1}. **${m.title}**`),
      '',
      '预期产出：1–5 条蒸馏知识条目（sourceReferences 回指全部原料）。',
      '确认后由 system-executor 执行一次蒸馏调用，原料归档移出主区；拒绝则本轮零副作用。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      content,
      'distill_proposal',
      {
        proposalId: proposal.id,
        materials: proposal.materials,
        signals: proposal.signals,
        workUnitId: proposal.triggerWorkUnitId ?? null,
      },
    );
    logger.info('[Distill] distill_proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, proposalId: proposal.id, materialCount: proposal.materials.length,
    });
    return true;
  } catch (e) {
    logger.warn('[Distill] Failed to post distill_proposal card', { proposalId: proposal.id, error: String(e) });
    return false;
  }
}
