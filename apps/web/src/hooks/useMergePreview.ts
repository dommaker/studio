// useMergePreview（#691 自 ChannelInput 抽出）：#632 发送前归属预览——触发条件 =
// 内容非空 + 无 replyTo + 无 @mention（MERGE_MENTION_RE 与后端 detectMention 同正则）+
// 非发送中；400ms 防抖拉 merge-target，失败静默撤条；seq 守卫防在途旧响应覆盖新结果；
// 频道切换预览与选择一并复位。
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChannelMessage, MergeTargetPreview, SendIntent } from '../api/channel';
import { channelApi } from '../api/channel';

/** 归属预览拉取防抖 */
const MERGE_PREVIEW_DEBOUNCE_MS = 400;
/** 与后端 detectMention 同正则——含 @mention 的内容不走 merge 归属预览 */
const MERGE_MENTION_RE = /@([\p{L}\p{N}_-]+)/u;

export interface UseMergePreviewOptions {
  channelId?: string;
  content: string;
  replyTo?: ChannelMessage | null;
  sending: boolean;
}

export interface MergePreviewController {
  /** 后端三态预测（unique/ambiguous/none）；不满足条件或拉取失败 → null */
  mergePreview: MergeTargetPreview | null;
  /** 用户显式归属选择；auto = 不发 intent */
  mergeChoice: 'auto' | SendIntent;
  setMergeChoice: Dispatch<SetStateAction<'auto' | SendIntent>>;
  mergePreviewEligible: boolean;
}

export function useMergePreview({ channelId, content, replyTo, sending }: UseMergePreviewOptions): MergePreviewController {
  const [mergePreview, setMergePreview] = useState<MergeTargetPreview | null>(null);
  const [mergeChoice, setMergeChoice] = useState<'auto' | SendIntent>('auto');

  const mergePreviewEligible =
    !!channelId && content.trim().length > 0 && !replyTo && !MERGE_MENTION_RE.test(content) && !sending;

  // 频道切换：预览与选择一并重置
  useEffect(() => {
    setMergePreview(null);
    setMergeChoice('auto');
  }, [channelId]);

  // 400ms 防抖拉 merge-target；内容变化重新判定，不满足条件即撤条。失败静默降级（不显示预览条）
  // B3：seq 守卫——防抖只挡新请求，已发出的旧请求响应仍会覆盖新结果；
  // 每次发请求 ++seq，响应只认最新 seq（退出分支同样 ++seq，使在途响应失效）
  const mergeSeqRef = useRef(0);
  useEffect(() => {
    if (!mergePreviewEligible || !channelId) {
      mergeSeqRef.current += 1;
      setMergePreview(null);
      return;
    }
    const timer = setTimeout(() => {
      const seq = ++mergeSeqRef.current;
      channelApi.getMergeTarget(channelId)
        .then(res => { if (seq === mergeSeqRef.current) setMergePreview(res.data.data); })
        .catch(() => { if (seq === mergeSeqRef.current) setMergePreview(null); });
    }, MERGE_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mergePreviewEligible, channelId, content]);

  return { mergePreview, mergeChoice, setMergeChoice, mergePreviewEligible };
}
