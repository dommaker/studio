/**
 * constraint-audit-card (#146) — 存量约束退役建议人审卡（复用 postGcProposalCard 模式）
 *
 * cardType='constraint_audit_proposal'，cardData 带 auditProposalId + 建议清单
 * （每条附判据 category 标签 + 理由）；approve/reject 接线见 distill.routes
 * （POST /api/v1/distill/audit/approve|reject）。
 * 发卡失败 / 频道缺失静默跳过（返回 false，由调用方标记提案 card-failed）——
 * 同 #101/#143 降级口径，蒸馏链路绝不被通知阻断。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import { AUDIT_CATEGORY_LABELS } from './constraint-audit.js';
import type { ConstraintAuditProposal } from './audit-store.js';

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/**
 * 发一张 cardType='constraint_audit_proposal' 卡到 #系统 频道。
 * 返回是否成功发出；频道缺失 / 发卡失败均静默（false），不抛。
 */
export async function postConstraintAuditCard(
  proposal: ConstraintAuditProposal,
  deps: { fileStore: FileStore },
): Promise<boolean> {
  try {
    const channel = (await deps.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return false; // 频道未播种 → 静默跳过

    const { channelMessageService } = await import('../channels/channel-message.service.js');

    const content = [
      '## 📏 存量约束退役建议 — 待确认',
      '',
      `蒸馏产出新约束，顺带审计存量约束 ${proposal.auditedCount} 条（判据：是否还有可被违反的未来场景）。`,
      '',
      `退役建议（${proposal.suggestions.length} 条）：`,
      ...proposal.suggestions.map((s, i) =>
        `${i + 1}. **${s.constraintId}**（${AUDIT_CATEGORY_LABELS[s.category]}）\n   ${s.rationale}`),
      '',
      '确认后走 retire 执行（custom-constraints.yml 条目内 retired 元数据段，可恢复）；拒绝则全部保留且后续不再提案。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      content,
      'constraint_audit_proposal',
      {
        auditProposalId: proposal.id,
        runId: proposal.runId,
        suggestions: proposal.suggestions,
        auditedCount: proposal.auditedCount,
      },
    );
    logger.info('[Distill] constraint_audit_proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, auditProposalId: proposal.id, suggestionCount: proposal.suggestions.length,
    });
    return true;
  } catch (e) {
    logger.warn('[Distill] Failed to post constraint_audit_proposal card', { auditProposalId: proposal.id, error: String(e) });
    return false;
  }
}
