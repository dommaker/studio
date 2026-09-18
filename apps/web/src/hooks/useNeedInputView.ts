// F2（2026-09-16 channel 性能体检）：needInputViewOf 产物内容等值复用——页面订阅的 stateItems
// 是全局切片，他频道 status_changed → action-center 整体替换重拉时，本频道投影等值即复用旧引用，
// 下游 useMemo（deriveStreamView 的 promotedQuestionIds/isWaitingForInput 依赖）不破裂、不白重算。
// 照 useActivityMessageItems stableRef 模式（#416）。
import { useMemo, useRef } from 'react';
import {
  needInputViewEqual,
  needInputViewOf,
  useNotificationStore,
  type NeedInputView,
} from '../stores/notificationStore';

export function useNeedInputView(channelId: string | undefined): NeedInputView {
  const stateItems = useNotificationStore(s => s.stateItems);
  const stableRef = useRef<NeedInputView | null>(null);
  return useMemo(() => {
    const next = needInputViewOf(stateItems, channelId);
    if (stableRef.current && needInputViewEqual(stableRef.current, next)) return stableRef.current;
    stableRef.current = next;
    return next;
  }, [stateItems, channelId]);
}
