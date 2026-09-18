// 频道消息流结构组件（#531，架构评审 2026-09-14 候选 3）：消费 useChannelStream 产物，
// 拥有「items → DOM」的全部结构分支——mc-stream-inner 容器、virtual/non-virtual 分支、
// spacer 高度、translateY 补偿、measureElement 行包裹、renderStreamItem 三 kind 分派
// （消息/线程组/告警组 × degraded × 日期分隔站位）、skeleton 占位行（含 highlight 目标为
// 骨架时的高亮）。整块自 ChannelDetailPage 渲染段搬移（PURE_MOVE 行为零变化）；
// 消息卡渲染本体（renderMessage）与 highlight 目标由页面经 props 注入。
import { Fragment, useCallback, type CSSProperties, type ReactNode } from 'react';
import type { ChannelMessage } from '../../api/channel';
import type { ChannelStream } from '../../hooks/useChannelStream';
import { streamDateStrOf, streamDateLabelOf, type StreamItem, type ThreadReplyView } from '../../utils/streamView';
import type { ChannelMessageItemProps } from './ChannelMessageItem';
import { IconAlertTriangle } from '../ui/icons';
import { avatarPattern } from '../../utils/avatar';
import { useChannelMessageEnv } from './ChannelMessageEnv';

/** #547：extra 逃生口收口——只含 7 个结构字段的封闭 Pick（deriveStreamView 产物经本通道喂入），
 *  编译期拒绝任意 prop 注入（原 Partial<Props> 已删）；横切值走 ChannelMessageEnv，不走本通道 */
export type StreamMessageExtra = Pick<
  ChannelMessageItemProps,
  'isThreadAnchor' | 'threadReplyCount' | 'isExpanded' | 'onToggleThread' | 'compact' | 'isThreadReply' | 'threadAnchorId'
>;

/** 页面 renderMessageItem 的签名（extra = 封闭结构 props 覆盖，见上） */
export type RenderStreamMessage = (
  msg: ChannelMessage,
  extra?: StreamMessageExtra,
) => ReactNode;

/** Phase 3（AC3）：告警组摘要行的首末消息时间（HH:MM；解析失败回退空串） */
function hhmmOf(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** 2026-09 视觉层次批次：折叠过程组作者归属——折叠条必须回答「这些消息是谁的」；
 *  去重后取前 2 名，>2 加「等」（过程组常态单作者，多作者列全撑爆行高） */
function procAuthorsOf(messages: ChannelMessage[]): string {
  const names = [...new Set(messages.map(m => m.agentName || 'Agent'))];
  const shown = names.slice(0, 2).map(n => `@${n}`).join('、');
  return names.length > 2 ? `${shown} 等` : shown;
}

/** proc-group 单作者判定：全部消息同一 agent → 返回作者名，否则 null（增量四链式合并前提） */
function singleAuthorOf(messages: ChannelMessage[]): string | null {
  const names = new Set(messages.map(m => m.agentName || 'Agent'));
  return names.size === 1 ? [...names][0] : null;
}

/** 卡片消息粗判（meta string/object 两形态）：链式合并不吞卡片——卡片自身就是全宽模块 */
function hasCardMeta(m: ChannelMessage): boolean {
  const meta = m.meta as unknown;
  if (!meta) return false;
  if (typeof meta === 'string') return meta.includes('cardType');
  return typeof meta === 'object' && 'cardType' in (meta as Record<string, unknown>);
}

/** 消息作者短名（线程锚点摘要头用，与 ChannelMessageItem quote 行同口径） */
function authorLabelOf(m: ChannelMessage): string {
  return m.authorType === 'human' ? '你' : m.agentName || 'Agent';
}

/** vc8：组内同作者相邻判定——折叠组/回复链内连续同作者消息省略重复头
 * （一个头像 + 多条消息，同 #277 D2 主流 compact 口径；原形态每条印一遍头像） */
function sameAuthorOf(a: ChannelMessage, b: ChannelMessage): boolean {
  return a.authorType === b.authorType && (a.agentName || 'Agent') === (b.agentName || 'Agent');
}

export function ChannelStreamBody({ stream, renderMessage, highlightId }: {
  stream: ChannelStream;
  renderMessage: RenderStreamMessage;
  highlightId: string | null;
}) {
  const { items, virtualEnabled, virtualizer, streamHeadH, streamInnerRef, toggleThread, toggleProcGroup, toggleAlertGroup } = stream;
  // vc7：线程归属头可点定位 anchor（env 横切值自取，缺 Provider → 纯展示降级，与消息项 quote 同口径）
  const onQuoteClick = useChannelMessageEnv()?.onQuoteClick;

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
              <IconAlertTriangle size={14} /> {item.messages.length} 条监控告警 · {item.criticalCount} CRITICAL · {item.warningCount} WARNING
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
              {/* 2026-09 视觉层次批次：线程归属头——容器属于哪条消息一眼可辨
                  （人类 anchor 是右侧气泡、容器在左下，无头时归属关系读不出）。
                  vc7：归属头升级为 anchor quote 的唯一承载位——组内回复 anchor 的逐条 quote 已抑制
                  （每条重复同一行引用，噪音淹没归属），本头 button 化承接 AC1 点击定位 anchor 契约；
                  缺 onQuoteClick（无 Provider）退化为纯展示 div，与消息项 quote 降级口径一致 */}
              {onQuoteClick ? (
                <button type="button" className="mc-thread-context" onClick={() => onQuoteClick(item.anchor.id)}
                  aria-label="定位被回复的消息">
                  回复 {authorLabelOf(item.anchor)}：{item.anchor.content}
                </button>
              ) : (
                <div className="mc-thread-context">回复 {authorLabelOf(item.anchor)}：{item.anchor.content}</div>
              )}
              {(() => {
                // 增量四：单作者折叠组 + 紧随的同作者可见消息 = 同一角色的连续输出，
                // 合成 .mc-reply-chain 角色消息模块（折叠条 = 模块头，结论消息 = 模块体）——
                // 原来折叠条与下方结论消息是两个独立块，读不出同属一个角色。
                // vc7：组内所有渲染带 threadAnchorId——quote 父消息 = anchor 的逐条重复引用被抑制
                const anchorId = item.anchor.id;
                const ris = item.replies;
                const nodes: ReactNode[] = [];
                for (let i = 0; i < ris.length; i++) {
                  const ri = ris[i];
                  if (ri.kind === 'msg') {
                    nodes.push(renderMessage(ri.message, { isThreadReply: true, compact: ri.compact, threadAnchorId: anchorId }));
                    continue;
                  }
                  const singleAuthor = singleAuthorOf(ri.messages);
                  const chain: Extract<ThreadReplyView, { kind: 'msg' }>[] = [];
                  if (singleAuthor) {
                    while (i + 1 < ris.length) {
                      const next = ris[i + 1];
                      if (next.kind === 'msg' && next.message.authorType === 'agent'
                        && (next.message.agentName || 'Agent') === singleAuthor
                        && !hasCardMeta(next.message)) {
                        chain.push(next);
                        i++;
                      } else break;
                    }
                  }
                  const toggle = (
                    <button onClick={() => toggleProcGroup(ri.key)} className="mc-collapse-toggle">
                      {ri.expanded
                        ? `收起 ${ri.messages.length} 条过程消息 · ${procAuthorsOf(ri.messages)}`
                        : `▸ ${ri.messages.length} 条过程消息 · ${procAuthorsOf(ri.messages)}`}
                    </button>
                  );
                  if (singleAuthor && chain.length > 0) {
                    nodes.push(
                      // vc6：链模块左色条 = 该作者 identicon 同号 --chart-* 色，与组内消息框同源同色。
                      // vc8：链内一个作者块只留一个头——组内消息首条带头、其余 compact；
                      // 展开时链消息紧跟过程消息（同作者）一并 compact，折叠时首条链消息留头
                      <div key={ri.key} className="mc-reply-chain"
                        style={{ '--mc-agent-color': `var(--chart-${avatarPattern(singleAuthor).paletteIndex + 1})` } as CSSProperties}>
                        {toggle}
                        {ri.expanded && ri.messages.map((reply, idx) => renderMessage(reply, { isThreadReply: true, threadAnchorId: anchorId, compact: idx > 0 }))}
                        {chain.map((c, idx) => renderMessage(c.message, { isThreadReply: true, threadAnchorId: anchorId, compact: c.compact || idx > 0 || (ri.expanded && ri.messages.length > 0) }))}
                      </div>,
                    );
                  } else {
                    nodes.push(
                      ri.expanded ? (
                        <div key={ri.key} className="mc-proc-group">
                          {toggle}
                          {/* vc8：多作者组内同作者相邻也省略重复头 */}
                          {ri.messages.map((reply, idx) => renderMessage(reply, { isThreadReply: true, threadAnchorId: anchorId, compact: idx > 0 && sameAuthorOf(reply, ri.messages[idx - 1]) }))}
                        </div>
                      ) : (
                        <Fragment key={ri.key}>{toggle}</Fragment>
                      ),
                    );
                  }
                }
                return nodes;
              })()}
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
  }, [renderMessage, renderSkeletonRow, toggleThread, toggleProcGroup, toggleAlertGroup, onQuoteClick]);

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
