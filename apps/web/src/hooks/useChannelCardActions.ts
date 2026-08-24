// 频道卡片 action 路由 hook（#322 自 ChannelDetailPage handleAction 整块搬移 + interface 收口）：
// 对外单一 dispatch(messageId, action) 入口，内部卡片 action 类型 → api 调用映射。
// knowledge_proposal approve → /knowledge-service/promote（draft→verified，参与注入）；
// reject → /knowledge-service/demote（draft→archived）。
// memory_proposal approve → /role-memory/promote（草稿→topic/索引）；reject → /role-memory/demote。
// distill_proposal approve → /distill/approve（#143 蒸馏运行）；reject → /distill/reject（零副作用）。
// gc_proposal approve → /distill/gc/approve（#144 GC 候选归档）；reject → /distill/gc/reject（零副作用）。
// constraint_audit_proposal approve → /distill/audit/approve（#146 约束退役执行）；reject → /distill/audit/reject（零副作用）。
// auditor_suggestion confirm/reject → POST /channels/:id/messages/:mid/card-decision（#278，采纳建未指派 task 工单；拒绝留痕）。
// retract_confirm confirm/reject → POST /skills/:id/retract/decide（#278，confirm→deprecated / reject→published，卡片状态同步回写）。
// 返回是否成功（卡片据此显示已审核状态）。
//
// 与原 handleAction 的唯一差异：messages 经渲染期镜像 ref 读取（dispatch identity 稳定，
// 支撑 #322 消息项 memo 的稳定 props 契约）；dispatch 体行为零变化。
import { useCallback, useRef } from 'react';
import type { ChannelMessage } from '../api/channel';
import { channelApi } from '../api/channel';
import { knowledgeApi } from '../api/knowledge';
import { memoryApi } from '../api/memory';
import { distillApi } from '../api/distill';
import { skillsApi } from '../api/skills';
import { parseMeta } from '../utils/messageMeta';

export interface UseChannelCardActionsOptions {
  channelId: string | undefined;
  messages: ChannelMessage[];
  refresh: () => void;
}

export function useChannelCardActions({ channelId, messages, refresh }: UseChannelCardActionsOptions) {
  // 渲染期镜像：dispatch 读最新 messages 而 identity 不随 messages 变化
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const dispatch = useCallback(async (messageId: string, action: string): Promise<boolean> => {
    if (action === 'converted') { refresh(); return true; }
    // 卡片 meta 解析（三种提案卡共用；缺 cardData → null，各分支按缺数据返回 false）
    // #264：meta 双型兼容——线上为 object，存量/夹具为 string
    const cardDataOf = (): Record<string, any> | null => {
      const msg = messagesRef.current.find(m => m.id === messageId);
      return parseMeta(msg?.meta).cardData ?? null;
    };
    if (action === 'knowledge_proposal_approve' || action === 'knowledge_proposal_reject') {
      const cardData = cardDataOf();
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { id?: unknown }) => e?.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (entryIds.length === 0) return false;
      const review = action === 'knowledge_proposal_approve'
        ? knowledgeApi.promote
        : knowledgeApi.demote;
      try {
        await Promise.all(entryIds.map(entryId => review(entryId)));
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'memory_proposal_approve' || action === 'memory_proposal_reject') {
      const cardData = cardDataOf();
      const roleId = typeof cardData?.roleId === 'string' ? cardData.roleId : '';
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { draftId?: unknown }) => e?.draftId)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (!roleId || entryIds.length === 0) return false;
      const review = action === 'memory_proposal_approve'
        ? memoryApi.promote
        : memoryApi.demote;
      try {
        await review(roleId, entryIds);
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'distill_proposal_approve' || action === 'distill_proposal_reject') {
      // #143 蒸馏提案：approve → /distill/approve；reject → /distill/reject（零副作用）
      const cardData = cardDataOf();
      const proposalId = typeof cardData?.proposalId === 'string' ? cardData.proposalId : '';
      if (!proposalId) return false;
      try {
        if (action === 'distill_proposal_approve') {
          const { data } = await distillApi.approve(proposalId);
          // 预算熔断（skipped）/ 执行失败 → 卡片保持待审（提案仍 pending，可重试）
          if (!data?.success) return false;
        } else {
          await distillApi.reject(proposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'gc_proposal_approve' || action === 'gc_proposal_reject') {
      // #144 GC 候选清单：approve → /distill/gc/approve（候选归档）；reject → /distill/gc/reject（零副作用）
      const cardData = cardDataOf();
      const gcProposalId = typeof cardData?.gcProposalId === 'string' ? cardData.gcProposalId : '';
      if (!gcProposalId) return false;
      try {
        if (action === 'gc_proposal_approve') {
          const { data } = await distillApi.gcApprove(gcProposalId);
          if (!data?.success) return false;
        } else {
          await distillApi.gcReject(gcProposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'constraint_audit_approve' || action === 'constraint_audit_reject') {
      // #146 存量约束审计：approve → /distill/audit/approve（retire 执行，可回滚）；reject → /distill/audit/reject（零副作用）
      const cardData = cardDataOf();
      const auditProposalId = typeof cardData?.auditProposalId === 'string' ? cardData.auditProposalId : '';
      if (!auditProposalId) return false;
      try {
        if (action === 'constraint_audit_approve') {
          const { data } = await distillApi.auditApprove(auditProposalId);
          if (!data?.success) return false;
        } else {
          await distillApi.auditReject(auditProposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    // #278（决策 #250 D2）：auditor_suggestion 卡接 card-decision 端点（human-only）。
    // 采纳 = 本频道建未指派 task 工单；拒绝 = 仅留痕。状态由后端回写 meta.status + SSE 推送。
    if (action === 'auditor_apply_confirm' || action === 'auditor_apply_reject') {
      if (!channelId) return false;
      try {
        await channelApi.cardDecision(channelId, messageId, action === 'auditor_apply_confirm' ? 'confirm' : 'reject');
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    // #278（决策 #250 D2）：retract_confirm 卡接技能退役决策端点（confirm→deprecated / reject→published）。
    if (action === 'retract_confirm' || action === 'retract_reject') {
      const cardData = cardDataOf();
      const skillId = typeof cardData?.skillId === 'string' ? cardData.skillId : '';
      if (!skillId) return false;
      try {
        await skillsApi.retractDecide(skillId, action === 'retract_confirm' ? 'confirm' : 'reject', messageId);
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, [channelId, refresh]);

  return dispatch;
}
