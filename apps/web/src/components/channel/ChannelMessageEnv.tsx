// 频道消息环境（#547，架构评审 2026-09-15 候选 B3，grilling 已决）：
// 横切值（卡片 action 路由 / 回复 / 消息查找 / 抽屉开启回调 / quote 定位）单 Provider 下发，
// ChannelMessageItem 经 useChannelMessageEnv() 自取——公开 Props 收窄到消息本体 + per-message 派生值，
// 页面 renderMessageItem 不再逐 prop 手喂横切值。
// #322 契约不变量：Provider 的 value 必须全部由稳定引用组成（useMemo 组装 + useCallback 成员），
// identity 不变 = 零重渲扇出；高频 volatile state（highlightId/focusedId/freshMsgIds）禁止进本 Context
// （value 一变全量消息项扇出重渲），per-message boolean 仍走 props（memo 友好）。
// fileVocabulary 不进本 Context——消息项直接复用 useChannelDataStore 既有 selector 模式自取（回调不进 store）。
import { createContext, useContext } from 'react';
import type { ChannelMessage } from '../../api/channel';

export interface ChannelMessageEnv {
  /** 统一卡片 action 路由（useChannelCardActions dispatch 单一入口） */
  onAction: (messageId: string, action: string) => void;
  onReply?: (message: ChannelMessage) => void;
  findMessage?: (id: string) => ChannelMessage | undefined;
  channelId?: string;
  /** Mission Control: 打开右抽屉（WorkUnit 详情） */
  onOpenWorkUnit?: (workUnitId: string) => void;
  /** #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」 */
  onOpenWorkUnitConfirm?: (workUnitId: string) => void;
  /** #467：plan_ruling 裁决轮接力卡「去裁决」 */
  onOpenWorkUnitRuling?: (workUnitId: string) => void;
  /** #567：plan_direction 方向锁定接力卡「去选定」 */
  onOpenWorkUnitDirection?: (workUnitId: string) => void;
  onOpenRequirement?: (reqId: string) => void;
  /** F5: NEED_INPUT 卡片内嵌回复；#276：返回 Promise 以便按真实成功置位「已回复」 */
  onInlineReply?: (message: ChannelMessage, content: string) => void | Promise<void>;
  /** channel 上下游优化 Phase 1（AC1）：quote 引用块点击定位上游消息 */
  onQuoteClick?: (messageId: string) => void;
}

const ChannelMessageEnvContext = createContext<ChannelMessageEnv | null>(null);

export const ChannelMessageEnvProvider = ChannelMessageEnvContext.Provider;

/** 缺 Provider（不应出现于生产——频道页装配层必挂）→ null，消息项各横切行为 fail-closed 不渲染 */
export function useChannelMessageEnv(): ChannelMessageEnv | null {
  return useContext(ChannelMessageEnvContext);
}
