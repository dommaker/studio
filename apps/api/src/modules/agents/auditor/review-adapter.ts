/**
 * review-adapter (#356) — auditor_suggestion 提案卡 adapter（接线 review-proposal 正本）
 *
 * ADR docs/adr/2026-08-25-review-proposal-lifecycle-module.md 决策落地：
 * - 决策 2（业务方只做 adapter）：各拷贝间真正不同的只有「卡片内容」（auditor_suggestion
 *   卡文案原样保留，cardData 在旧形状 { suggestions } 上增 proposalId 供通用端点审批；
 *   作者保持 'Auditor'，经正本 card 投放的 author 透传）与「审批后动作」（onApprove →
 *   本频道建 type:task 未指派工单，自旧 card-decision.service confirm 分支原样搬入；
 *   onReject → 零副作用，拒绝 = 仅留痕，墓碑归正本）；存取/发卡/approve/reject
 *   生命周期全部归 review-proposal 正本。
 * - 决策 4（通用端点）：审批走 /api/v1/review-proposals/auditor/:id/{approve,reject,status}；
 *   旧专有端点 POST /channels/:id/messages/:messageId/card-decision 随删。
 *
 * 存储：正本默认物化 <dataDir>/auditor-proposals.jsonl（append-only + 状态墓碑折叠），
 * 词表 pending|executed|rejected|failed|card-failed。旧实现无自持提案存储（卡片状态记在
 * 消息 meta.status），故无历史存储迁移问题；接线前发出的存量卡（cardData 无 proposalId）
 * 不再可审批——前端按 meta.status 直读旧终态只读展示，同 #354/#355 存量口径。
 */
import { randomUUID } from 'node:crypto';
import { FileStore, logger } from '@dommaker/studio-shared';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../../review-proposal/registry.js';
import { submitProposal } from '../../review-proposal/service.js';
import type { ReviewProposalBase, ReviewProposalRecord } from '../../review-proposal/store.js';
import { parseMessageMeta } from '../../../utils/message-meta.js';
import { getErrorMessage } from '../../../utils/errors.js';
import type { Suggestion } from './auditor-rules.js';

/** 审核闭环：提案卡投放的目标频道（同旧 pushConfirmationCards / 正本 card.ts 口径） */
const SYSTEM_CHANNEL_NAME = '#系统';

/** auditor 提案载荷（行形态：{ kind:'proposal', ... } 落 auditor-proposals.jsonl） */
export interface AuditorReviewProposal extends ReviewProposalBase {
  suggestions: Suggestion[];
}

/**
 * 卡片渲染：旧卡文案原样保留（行为一致；cardType='auditor_suggestion' 前后端契约不变）。
 * cardData = 旧形状 { suggestions } + proposalId（通用端点审批接线用）。
 */
function renderAuditorCard(p: AuditorReviewProposal): { content: string; cardData: Record<string, unknown> } {
  const content = [
    '## 🔧 审计建议 — 待人工确认',
    '',
    ...p.suggestions.map((s, i) => {
      const icon = s.type === 'param_tuning' ? '⚙️' : s.type === 'circuit_fix' ? '🔴' : '📝';
      return `${i + 1}. ${icon} **${s.detail}**`;
    }),
    '',
    '请确认是否执行以上建议。',
  ].join('\n');
  return { content, cardData: { proposalId: p.id, suggestions: p.suggestions } };
}

/**
 * approve 后动作：本频道（#系统）建 type:task 未指派工单——
 * 自旧 card-decision.service confirm 分支原样搬入（正文 = 建议详情 + 原卡链接，
 * metadata.creationMode='card-decision'，unassigned 待认领走既有执行链）。
 * 卡消息经 cardData.proposalId 反查：查不到（卡被删/归档）仍建工单但不落原卡链接——
 * 根因：提案存取归正本后，卡消息存续不再是审批前置（append-only 提案才是合法状态源），
 * 审批不应被卡消息删除阻断。
 */
async function executeAuditorApproval(
  fileStore: FileStore,
  p: ReviewProposalRecord<AuditorReviewProposal>,
): Promise<ApproveOutcome> {
  try {
    const channel = (await fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return { status: 'aborted', error: 'system-channel-missing' };

    // 反查卡消息（取原卡链接用）；查不到不阻断（见 docstring 根因说明）
    const cardMessage = (await fileStore.queryMessages(channel.id)).find(m => {
      const cardData = parseMessageMeta(m.meta).cardData as { proposalId?: unknown } | undefined;
      return cardData?.proposalId === p.id;
    });

    const suggestions = p.suggestions;
    const detailLines = suggestions.map(s =>
      `- [${s.type ?? 'unknown'}${s.risk === 'high' ? '/高风险' : ''}] ${s.detail ?? ''}`.trim(),
    );
    const description = [
      '审计建议采纳（Auditor 建议卡）：',
      '',
      ...detailLines,
      '',
      cardMessage ? `原卡：频道 ${channel.id} 消息 ${cardMessage.id}` : '原卡：消息已删除或归档',
    ].join('\n');
    const scopeSource = detailLines.map(l => l.replace(/^- \[[^\]]*\]\s*/, '')).join('；');

    const { WorkUnitService } = await import('../../workunit/workunit.service.js');
    const workUnit = await new WorkUnitService(fileStore).create({
      scope: `审计建议：${scopeSource}`.slice(0, 500),
      channelId: channel.id,
      type: 'task',
      status: 'unassigned',
      assigneeId: null,
      workspaceId: channel.defaultWorkspaceId ?? null,
      metadata: {
        creationMode: 'card-decision',
        ...(cardMessage ? { originalMessageId: cardMessage.id } : {}),
        description,
      },
    });
    logger.info('[AuditorService] Suggestion approved → task created', {
      proposalId: p.id, workUnitId: workUnit.id,
    });
    return { status: 'executed', data: { workUnitId: workUnit.id } };
  } catch (e) {
    return { status: 'failed', error: getErrorMessage(e) };
  }
}

/**
 * 注册 auditor adapter（kind='auditor'）。同 kind 重复注册后者生效（幂等）。
 * 运行时装配 = auditor.service.ts 单例创建处（模块加载即注册，保证重启后存量
 * pending 提案可审批）；submitAuditorSuggestionProposal 自助注册兜底（同 #353–#355 口径）。
 */
export function registerAuditorReviewAdapter(deps?: {
  fileStore?: FileStore;
  dataDir?: string;
}): ReviewProposalAdapter<AuditorReviewProposal> {
  const fileStore = deps?.fileStore ?? new FileStore();
  return registerReviewProposalAdapter<AuditorReviewProposal>({
    kind: 'auditor',
    cardType: 'auditor_suggestion',
    storeNamespace: 'auditor-proposals',
    dataDir: deps?.dataDir ?? studioDir(),
    fileStore,
    author: 'Auditor',
    renderCardContent: renderAuditorCard,
    onApprove: p => executeAuditorApproval(fileStore, p),
  });
}

/** 取 auditor adapter（未注册则自助注册，幂等） */
export function getAuditorReviewAdapter(): ReviewProposalAdapter<AuditorReviewProposal> {
  return getReviewProposalAdapter<AuditorReviewProposal>('auditor') ?? registerAuditorReviewAdapter();
}

/**
 * 建提案 + 发卡（正本 submitProposal：append-only 落 pending → 发卡 → 失败落 card-failed 墓碑）。
 * 空建议静默跳过（旧 pushConfirmationCards 同款早退）；发卡失败不抛
 * （#101/#143 降级口径，审计链路绝不被通知阻断）。
 */
export async function submitAuditorSuggestionProposal(
  suggestions: Suggestion[],
  deps?: { fileStore?: FileStore; dataDir?: string },
): Promise<{ proposalId: string; posted: boolean }> {
  if (suggestions.length === 0) return { proposalId: '', posted: false };
  const adapter = deps
    ? registerAuditorReviewAdapter(deps)
    : getAuditorReviewAdapter();
  const proposal: AuditorReviewProposal = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    suggestions,
  };
  const { posted } = await submitProposal(adapter, proposal);
  return { proposalId: proposal.id, posted };
}
