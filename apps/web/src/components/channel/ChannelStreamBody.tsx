// 频道消息流结构组件（#531，架构评审 2026-09-14 候选 3）：消费 useChannelStream 产物，
// 拥有「items → DOM」的全部结构分支——mc-stream-inner 容器、virtual/non-virtual 分支、
// spacer 高度、translateY 补偿、measureElement 行包裹、renderStreamItem 三 kind 分派
// （消息/线程组/告警组 × degraded × 日期分隔站位）、skeleton 占位行（含 highlight 目标为
// 骨架时的高亮）。整块自 ChannelDetailPage 渲染段搬移（PURE_MOVE 行为零变化）；
// 消息卡渲染本体（renderMessage）与 highlight 目标由页面经 props 注入。
import { useCallback, type ComponentProps, type ReactNode } from 'react';
import type { ChannelMessage } from '../../api/channel';
import type { ChannelStream } from '../../hooks/useChannelStream';
import { streamDateStrOf, streamDateLabelOf, type StreamItem } from '../../utils/streamView';
import type { ChannelMessageItem } from './ChannelMessageItem';

/** 页面 renderMessageItem 的原签名（extra = ChannelMessageItem 可选 props 覆盖） */
export type RenderStreamMessage = (
  msg: ChannelMessage,
  extra?: Partial<ComponentProps<typeof ChannelMessageItem>>,
) => ReactNode;

/** Phase 3（AC3）：告警组摘要行的首末消息时间（HH:MM；解析失败回退空串） */
function hhmmOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChannelStreamBody({ stream, renderMessage, highlightId }: {
  stream: ChannelStream;
  renderMessage: RenderStreamMessage;
  highlightId: string | null;
}) {
  const { items, virtualEnabled, virtualizer, streamHeadH, streamInnerRef, toggleThread, toggleProcGroup, toggleAlertGroup } = stream;

  // #326：骨架占位行——degraded 消息（含 thread anchor）渲染为固定占位行，
  // 保留 data-message-id（锚点捕获/阅读位置仍可按 mid 定位）；水合后原位恢复。
  // #439 走查修复：highlight 目标为骨架时同样给 mc-msg-highlight——否则 ?highlight 直达
  // 老消息（掉出 PRUNE_KEEP_RECENT 被降级）定位成功但高亮不可见；水合后原位恢复为全量行。
  const renderSkeletonRow = useCallback((mid: string, dateNode: React.ReactNode) => (
    <>
      {dateNode}
      <div className={`mc-msg-skeleton${highlightId === mid ? ' mc-msg-highlight' : ''}`} data-message-id={mid}>历史消息已卸载 · 滚动经过自动加载</div>
    </>
  ), [highlightId]);

  // #325：单个 stream item 的渲染内容（日期分隔 + 消息/线程组）——外层包裹（key/测量）
  // 由下方两条路径分别决定：非虚拟化路径 = 普通 div；虚拟化路径 = data-index + measureElement 行
  const renderStreamItem = useCallback((item: StreamItem) => {
    // Phase 3（AC3）：主流告警组——折叠 = 单行摘要（条数 + severity 计数 + 首末时间范围）；
    // 展开 = 摘要行（兼收起入口）+ 组内消息逐条渲染（复用 renderMessage，memo 契约不变）。
    // 组内跨天（聚合 pass 在日期分隔之后做）时组内自渲染日期分隔；折叠摘要行按首条日期站位主流分隔。
    if (item.kind === 'alert-group') {
      const first = item.messages[0];
      const last = item.messages[item.messages.length - 1];
      return (
        <>
          {item.showDate && (
            <div className="mc-date" key={item.dateKey}>{item.dateLabel}</div>
          )}
          <div className={`mc-alert-group${item.expanded ? ' mc-alert-group-expanded' : ''}`}>
            <button
              type="button"
              className="mc-alert-group-summary"
              aria-expanded={item.expanded}
              onClick={() => toggleAlertGroup(item.key)}
            >
              ⚠ {item.messages.length} 条监控告警 · {item.criticalCount} CRITICAL · {item.warningCount} WARNING
              · {hhmmOf(first.createdAt)}–{hhmmOf(last.createdAt)}
            </button>
            {item.expanded && (
              <div className="mc-alert-group-body">
                {item.messages.map((m, i) => {
                  // 组内跨天：相邻消息日期串不同则插组内日期分隔（首条不占——组的分隔在主流）
                  const innerDate = i > 0 && streamDateStrOf(m) !== streamDateStrOf(item.messages[i - 1])
                    ? <div className="mc-date mc-alert-group-date" key={`date-${m.id}`}>{streamDateLabelOf(m, streamDateStrOf(m))}</div>
                    : null;
                  return (
                    <div key={m.id}>
                      {innerDate}
                      {m.degraded
                        ? renderSkeletonRow(m.id, null)
                        : renderMessage(m)}
                    </div>
                  );
                })}
                <button type="button" className="mc-collapse-toggle" onClick={() => toggleAlertGroup(item.key)}>
                  收起 {item.messages.length} 条监控告警
                </button>
              </div>
            )}
          </div>
        </>
      );
    }
    if (item.kind === 'thread') {
      if (item.anchor.degraded) {
        return renderSkeletonRow(item.anchor.id, item.showDate && (
          <div className="mc-date" key={item.dateKey}>{item.dateLabel}</div>
        ));
      }
      return (
        <>
          {item.showDate && (
            <div className="mc-date" key={item.dateKey}>
              {item.dateLabel}
            </div>
          )}
          {renderMessage(item.anchor, {
            isThreadAnchor: true,
            threadReplyCount: item.replyCount,
            isExpanded: item.expanded,
            onToggleThread: toggleThread,
            compact: item.compact,
          })}
          {item.expanded && item.replyCount > 0 && (
            <div className="mc-thread-replies">
              {item.replies.map(ri => {
                if (ri.kind === 'msg') {
                  return renderMessage(ri.message, { isThreadReply: true, compact: ri.compact });
                }
                return ri.expanded ? (
                  <div key={ri.key}>
                    <button onClick={() => toggleProcGroup(ri.key)} className="mc-collapse-toggle">
                      收起 {ri.messages.length} 条过程消息
                    </button>
                    {ri.messages.map(reply => renderMessage(reply, { isThreadReply: true }))}
                  </div>
                ) : (
                  <button key={ri.key} onClick={() => toggleProcGroup(ri.key)} className="mc-collapse-toggle">
                    ▸ {ri.messages.length} 条过程消息
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
    }
    return (
      <>
        {item.showDate && (
          <div className="mc-date" key={item.dateKey}>
            {item.dateLabel}
          </div>
        )}
        {item.message.degraded
          ? renderSkeletonRow(item.message.id, null)
          : renderMessage(item.message, { compact: item.compact })}
      </>
    );
  }, [renderMessage, renderSkeletonRow, toggleThread, toggleProcGroup, toggleAlertGroup]);

  // #325：虚拟化路径只渲染窗口内行（spacer 撑总高 + 块平移），非虚拟化（jsdom）全量渲染
  return (
    <div
      className="mc-stream-inner"
      ref={streamInnerRef}
      style={virtualEnabled ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
    >
      {/* B2-002: Date separators + B2-006: collapse completed + AC-C3: threads
          #322: 归组/折叠/合并/日期分隔/可见性由 deriveStreamView 算出（useChannelStream 内化） */}
      {virtualEnabled ? (
        <div style={{ transform: `translateY(${(virtualizer.getVirtualItems()[0]?.start ?? 0) - streamHeadH}px)` }}>
          {virtualizer.getVirtualItems().map(vi => (
            <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement}>
              {renderStreamItem(items[vi.index])}
            </div>
          ))}
        </div>
      ) : (
        items.map(item => (
          <div key={item.kind === 'thread' ? item.anchor.id : item.kind === 'alert-group' ? item.key : item.message.id}>
            {renderStreamItem(item)}
          </div>
        ))
      )}
    </div>
  );
}
