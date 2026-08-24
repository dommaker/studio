// 频道消息流滚动跟随判定（#289，借鉴 dsh observed-top 台账方案，
// 见 .studio/research/2026-08-19-dsh-web-interaction.md §5）
// jsdom 无布局不可测 scrollTop，故判定逻辑全部抽为纯函数在此单测；
// 组件侧只负责记账（observedTopRef）与调用。

/** 钉底阈值：距底 ≤ 该值视为「还在底部」。#290（清单 #27）由 80 收紧到 24：
 *  80px 在短消息流里≈永远跟随，向上翻阅读时新消息会把读者拽回底部。 */
export const FOLLOW_THRESHOLD_PX = 24;

export interface StreamScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底距离（px），贴底为 0 */
export function distanceFromBottom(s: StreamScrollSnapshot): number {
  return s.scrollHeight - s.scrollTop - s.clientHeight;
}

/** 是否钉在底部（跟随新消息的几何判定） */
export function isPinnedToBottom(s: StreamScrollSnapshot, thresholdPx: number = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(s) <= thresholdPx;
}

/**
 * 读者滚动归属判定：程序写 scrollTop 必记 observed-top 台账，
 * scroll 事件里实际位置偏离台账（>1px 容差，吃浏览器取整）才算读者滚的。
 * observedTop 为 null（尚未有程序写入）时保守视为读者滚动。
 */
export function isReaderScroll(actualTop: number, observedTop: number | null, tolerancePx = 1): boolean {
  if (observedTop === null) return true;
  return Math.abs(actualTop - observedTop) > tolerancePx;
}

/** 新消息到达时是否跟随到底：钉底中，或最后一条是自己发的（发送动作强制回底） */
export function shouldFollowBottom(pinned: boolean, lastAuthorIsHuman: boolean): boolean {
  return pinned || lastAuthorIsHuman;
}

// ── #290（清单 #22/#27）：行锚点 ──────────────────────────────

/** 消息行矩形（视口相对坐标，mid = data-message-id 行身份） */
export interface MessageRowRect {
  mid: string;
  top: number;
  bottom: number;
}

/** 行锚点：首个可见消息行的身份与其视口相对 top */
export interface ScrollAnchor {
  mid: string;
  top: number;
}

/**
 * 捕获首个可见消息行作为锚点（rows 按文档序）。
 * 行底部越过视口顶即算可见（部分露出的首行是读者的当前阅读位置）。
 * 无可捕获行（空列表/全在视口上方）返回 null。
 */
export function captureFirstVisibleAnchor(rows: MessageRowRect[], viewportTop = 0): ScrollAnchor | null {
  const row = rows.find(r => r.bottom > viewportTop);
  return row ? { mid: row.mid, top: row.top } : null;
}

/** 锚点位移补偿量：prepend 后锚行新 top - 旧 top，加到 scrollTop 上视口即停在原行 */
export function anchorScrollDelta(anchorTopBefore: number, anchorTopAfter: number): number {
  return anchorTopAfter - anchorTopBefore;
}
