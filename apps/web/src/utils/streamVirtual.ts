// 频道消息流虚拟化（#325，ADR 2026-08-24 channel-stream-virtualization）：
// jsdom 无布局不可测 virtualizer 本体，虚拟化相关判定/映射/补偿数学全部抽纯函数在此单测；
// hook/组件侧只负责接线（useStreamFollow 建 virtualizer、ChannelDetailPage 渲染窗口）。
import type { StreamItem } from './streamView';

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
 *   scrollTop = scrollMargin + item 新 start + item 内偏移 - anchorTop
 * withinItemOffset = 锚行内容偏移 - (scrollMargin + item 旧 start)，prepend 前捕获。
 */
export function anchorScrollTopAfterPrepend(args: {
  scrollMargin: number;
  newItemStart: number;
  withinItemOffset: number;
  anchorTop: number;
}): number {
  return args.scrollMargin + args.newItemStart + args.withinItemOffset - args.anchorTop;
}

/** 钉底判定（ADR D4-4：虚拟化下重定义为末行局部几何，不依赖总高度） */
export function isPinnedToEnd(distanceFromEndPx: number, thresholdPx: number): boolean {
  return distanceFromEndPx <= thresholdPx;
}
