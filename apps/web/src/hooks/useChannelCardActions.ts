// 频道卡片 action 路由 hook（#322 自 ChannelDetailPage handleAction 整块搬移 + interface 收口）：
// 对外单一 dispatch(messageId, action) 入口，内部卡片 action 类型 → api 调用映射。
// #352（ADR 2026-08-25 决策 5）：5 段人审提案同构分支坍缩为参数化调用——PROPOSAL_ACTION_INDEX
// 由 proposalCardConfigs 派生，config.exec(cardData, decision) 承载各域副作用：
// distill/gc/audit/memory 走通用端点 /review-proposals/:kind/:id/{approve,reject}（#351/#353）；
// knowledge → /knowledge-service/promote|demote（待 #355 后端接线后切通用端点，届时只改配置条目）。
// auditor_suggestion confirm/reject → POST /channels/:id/messages/:mid/card-decision（#278，采纳建未指派 task 工单；拒绝留痕）。
// retract_confirm confirm/reject → POST /skills/:id/retract/decide（#278，confirm→deprecated / reject→published，卡片状态同步回写）。
// 返回是否成功（卡片据此显示已审核状态）。
//
// 与原 handleAction 的唯一差异：messages 经渲染期镜像 ref 读取（dispatch identity 稳定，
// 支撑 #322 消息项 memo 的稳定 props 契约）；dispatch 体行为零变化。
import { useCallback, useRef } from 'react';
import type { ChannelMessage } from '../api/channel';
import { channelApi } from '../api/channel';
import { skillsApi } from '../api/skills';
import { PROPOSAL_ACTION_INDEX } from '../components/channel/proposalCardConfigs';
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
    // 卡片 meta 解析（提案卡与 retract 卡共用；缺 cardData → null，exec/分支按缺数据返回 false）
    // #264：meta 双型兼容——线上为 object，存量/夹具为 string
    const cardDataOf = (): Record<string, any> | null => {
      const msg = messagesRef.current.find(m => m.id === messageId);
      return parseMeta(msg?.meta).cardData ?? null;
    };
    // #352：人审提案卡参数化分发（5 段同构分支坍缩）——action → config.exec(cardData, decision)；
    // exec false（缺数据 / approve success=false 预算熔断等）→ 不 refresh 返回 false；异常归一为 false
    const proposal = PROPOSAL_ACTION_INDEX[action];
    if (proposal) {
      try {
        const ok = await proposal.config.exec(cardDataOf(), proposal.decision);
        if (!ok) return false;
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
