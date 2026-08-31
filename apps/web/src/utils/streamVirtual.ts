// 频道消息流虚拟化（#325，ADR 2026-08-24 channel-stream-virtualization）：
// jsdom 无布局不可测 virtualizer 本体，虚拟化相关判定/映射/补偿数学全部抽纯函数在此单测；
// hook/组件侧只负责接线（useStreamFollow 建 virtualizer、ChannelDetailPage 渲染窗口）。
import type { StreamItem } from './streamView';
import { anchorScrollDelta, type ScrollAnchor } from './streamFollow';

/**
 * 测试 seam：jsdom 无布局（vitest MODE=test）时关闭虚拟化、渲染全量——
 * 既有页面测试语义零变化；虚拟化行为由本文件纯函数单测 + 浏览器实测覆盖。
 */
export const STREAM_VIRTUAL_ENABLED = import.meta.env.MODE !== 'test';

/** 虚拟行 key：thread 取 anchor.id、message 取 message.id（prepend 下稳定，measurements 按 key 存续） */
export function streamItemKey(item: StreamItem): string {
  return item.kind === 'thread' ? item.anchor.id : item.message.id;
}

/**
 * 消息 id → item index 映射（锚点补偿/阅读位置恢复/highlight 定位的 mid→item 桥）。
 * thread 项覆盖 anchor + 全部 replies（含折叠态、含过程组内消息——它们同属一个虚拟行，
 * item 内偏移在 prepend 下不变，补偿公式兼容）。
 */
export function buildMessageToItemIndex(items: StreamItem[]): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === 'message') {
      map.set(item.message.id, index);
      return;
    }
    map.set(item.anchor.id, index);
    for (const reply of item.replies) {
      if (reply.kind === 'msg') map.set(reply.message.id, index);
      else for (const m of reply.messages) map.set(m.id, index);
    }
  });
  return map;
}

/**
 * prepend 锚点补偿（D4-2 验证约束 1：数据源 = virtualizer measurements 按 key 查 start，
 * 不能用 prepend 后的 DOM 查询——锚行已掉出渲染窗口）。
 * 补偿后锚行视口相对 top 保持 anchorTop 不变：
 *   scrollTop = item 新 start + item 内偏移 - anchorTop
 * newItemStart 为滚动内容坐标（virtualizer measurements 的 start 已含 scrollMargin）；
 * withinItemOffset = 锚行内容偏移 - item 旧 start，prepend 前捕获，prepend 下不变。
 */
export function anchorScrollTopAfterPrepend(args: {
  newItemStart: number;
  withinItemOffset: number;
  anchorTop: number;
}): number {
  return args.newItemStart + args.withinItemOffset - args.anchorTop;
}

// ── #339：阅读位置恢复第二段（精校正）的时机决策 ──────────────

/**
 * virtualizer 滚动收敛判定：scrollToIndex 会置内部 scrollState 并启动 rAF reconcile
 * 循环——测量落地使目标偏移变化时反复把 scrollTop 改写回 align-start 目标
 * （稳定 1 帧即收敛，上限 5s；依据 @tanstack/virtual-core 3.17.8
 * dist/esm/index.js 的 scrollToIndex / scheduleScrollReconcile / reconcileScroll）。
 * 收敛 = scrollState 清空。该字段在库类型里是 private（无公开收敛信号），
 * 此处按上述版本运行时读取——升级 @tanstack/react-virtual 时必须复核本假设。
 */
export function virtualizerScrollSettled(virtualizer: unknown): boolean {
  const scrollState = (virtualizer as { scrollState?: unknown } | null | undefined)?.scrollState;
  return scrollState == null;
}

/** 精校正第二段决策（调用方保证 pending 非空，pending 为空 = 无事可做不进本判定） */
export type FineAdjustDecision =
  | { action: 'wait' }
  | { action: 'abandon' }
  | { action: 'apply'; delta: number };

/**
 * 收敛后锚行缺席的宽限帧数：首个 settle 观察帧可能早于锚行所在 React 提交一拍
 * （scroll 事件在渲染步内先于 rAF 派发，virtualizer notify 触发的提交经宏任务在
 * 下一轮任务相才落地），单帧缺席即放弃会误杀精校正；连续缺席超宽限才视为
 * 永久缺失（折叠 thread 内回复/过滤吃掉），保持粗定位落位。
 */
export const FINE_ADJUST_MISSING_GRACE_FRAMES = 10;

/**
 * 精校正落地/放弃决策（纯函数，#339；分支矩阵在此全量可测，hook 侧只机械接线）：
 * - 收敛前一律 wait——reconcile 循环仍在改写 scrollTop，此刻校正落地必被踩掉（#339 根因）；
 * - 未归类滚动在途（读者滚动事件尚未派发）→ abandon——读者意图优先，不拽回；
 * - 收敛后锚行在 DOM → apply——delta 加到 scrollTop 上锚行即回到存档 top（复用 anchorScrollDelta 语义）；
 * - 收敛后锚行缺席 → 宽限期内 wait，超过 FINE_ADJUST_MISSING_GRACE_FRAMES 连续缺席才 abandon。
 */
export function planFineAdjust(args: {
  pending: ScrollAnchor;
  settled: boolean;
  /** 锚行当前视口相对 top；未收敛时调用方传 null（本函数先按 settled 短路，null 此时无语义），收敛后 null = 不在 DOM */
  anchorTop: number | null;
  /** 收敛且锚行缺席的连续帧数（调用方逐帧累计，非收敛帧清零） */
  settledMissingFrames: number;
  /** 未归类滚动在途（实际 scrollTop 偏离程序写入台账） */
  readerScrollInFlight: boolean;
}): FineAdjustDecision {
  if (!args.settled) return { action: 'wait' };
  if (args.readerScrollInFlight) return { action: 'abandon' };
  if (args.anchorTop !== null) return { action: 'apply', delta: anchorScrollDelta(args.pending.top, args.anchorTop) };
  return args.settledMissingFrames < FINE_ADJUST_MISSING_GRACE_FRAMES ? { action: 'wait' } : { action: 'abandon' };
}
