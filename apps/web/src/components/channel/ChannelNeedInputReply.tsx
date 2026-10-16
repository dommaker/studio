// 拆分来源：components/channel/ChannelMessageItem.tsx F5 NEED_INPUT 内嵌回复块整块
//（draft/已回复/发送中三态 + sendNeedReply + 结构化选项卡 + 单行回复框 fallback +
//  IME 守卫随本体走；#276 await 真实结果、#276 AC1 挂起复活重置语义零变更）
import { useEffect, useRef, useState } from 'react';
import type { ChannelMessage } from '../../api/channel';
import { IconCheck } from '../ui/icons';
import { NeedInputOptions } from './NeedInputOptions';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';
import type { CardMeta, MetaOption } from '../../utils/messageMeta';
import type { ChannelMessageEnv } from './ChannelMessageEnv';

export interface ChannelNeedInputReplyProps {
  message: ChannelMessage;
  /** F5: 关联 WorkUnit 挂起等待人类回复——父组件 `waitingForInput && onInlineReply` 守卫内渲染 */
  waitingForInput: boolean;
  /** parseMeta 产物（options/multiSelect 结构化选项卡用；卡片分派仍归 ChannelMessageItem） */
  meta: CardMeta;
  /** #276：返回 Promise 以便按真实成功置位「已回复」 */
  onInlineReply: NonNullable<ChannelMessageEnv['onInlineReply']>;
}

/** F5: NEED_INPUT 卡片内嵌回复区——走与回复按钮完全相同的链路（sendMessage + replyToId），
 *  后端 message-routing 检测 replyTo 继承 workUnitId 后调 resumeWaitingWorkUnit */
export function ChannelNeedInputReply({ message, waitingForInput, meta, onInlineReply }: ChannelNeedInputReplyProps) {
  const [needDraft, setNeedDraft] = useState('');
  const [needSent, setNeedSent] = useState(false);
  // #276（P2 #15）：发送中状态——禁用表单防重复触发，await 真实结果后才置位「已回复」
  const [needSending, setNeedSending] = useState(false);

  // F5: 内嵌回复发送（逻辑拆分来源：ChannelMessageItem.tsx sendNeedReply，原样平移）
  const sendNeedReply = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || needSending) return;
    setNeedSending(true);
    try {
      await onInlineReply(message, trimmed);
      setNeedDraft('');
      setNeedSent(true);
    } catch {
      // #276：失败不置位「已回复」，表单/选项恢复可用，draft 保留可重试
    } finally {
      setNeedSending(false);
    }
  };

  // #276 AC1：以 WU 真实状态为准——回复成功后 WU 复活又再度挂起（waitingForInput false→true，
  // 仍落本条提问），重置 needSent 回到「等待回复」态。父组件守卫 `waitingForInput &&` 下
  // 本区随 false 卸载、回 true 重挂，重置由重挂天然达成；保留显式重置兜
  // 「实例不卸载仅 prop 翻牌」路径（对齐原 ChannelMessageItem 内 prevWaiting 语义）
  const prevWaiting = useRef(waitingForInput);
  useEffect(() => {
    if (waitingForInput && !prevWaiting.current) {
      setNeedSent(false);
      setNeedDraft('');
    }
    prevWaiting.current = waitingForInput;
  }, [waitingForInput]);

  // #267（决策 #250 D3）：meta.options 存在 → 结构化选项卡（点选即发送内嵌回复）；
  // 无 options → 现有单行回复框 fallback。防御性过滤非法元素（缺 label 的丢弃）
  const needOptions: MetaOption[] | undefined = Array.isArray(meta.options)
    ? meta.options.filter((o): o is MetaOption => !!o && typeof o.label === 'string')
    : undefined;

  // #270：NEED_INPUT 内嵌回复框共享 composer 同款 IME 守卫
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  // #276：needSent 仅在 await 真实发送成功后置位；发送中禁用表单防重复触发
  return needSent ? (
    <div className="mc-need-sent"><IconCheck size={12} /> 已回复</div>
  ) : needOptions && needOptions.length > 0 ? (
    <NeedInputOptions
      options={needOptions}
      multiSelect={meta.multiSelect === true}
      disabled={needSending}
      onReply={content => void sendNeedReply(content)}
    />
  ) : (
    <div className="mc-need-form">
      <input
        aria-label={`回复 ${message.workUnitId ?? message.id}`}
        placeholder="直接在此回复…"
        value={needDraft}
        onChange={e => setNeedDraft(e.target.value)}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={e => {
          // #270：IME 选词 Enter 不发送；长按不连发；#276：发送中防重复 Enter
          if (e.key !== 'Enter' || isImeEvent(e) || e.repeat || needSending) return;
          void sendNeedReply(needDraft);
        }}
        disabled={needSending}
      />
      <button
        className="mc-btn mc-btn-primary"
        onClick={() => void sendNeedReply(needDraft)}
        disabled={!needDraft.trim() || needSending}
      >
        {needSending ? '发送中…' : '回复'}
      </button>
    </div>
  );
}
