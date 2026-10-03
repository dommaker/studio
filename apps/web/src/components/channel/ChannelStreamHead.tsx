// ChannelStreamHead — 消息流头部块（P3-b 自 ChannelDetailPage 切出）：
// 首拉骨架 / 首拉失败错误态（#482：与真空频道区分，防误判空频道）/ 空频道示例提示 chip
// （视觉批次 2 ⑥，点击走 prefill 通道不自动发送）/ 「加载更早的消息」（B2-002）/
// 已完成折叠 toggle（B2-006）。
// 结构契约：本体即 .mc-stream-head 测量容器（ref 挂点——组合层量作 virtualizer scrollMargin，
// #431 定性保留），无样式需求；空态仅此一处渲染点（虚拟化/非虚拟化共用）。
import { forwardRef } from 'react';
import { SkeletonText } from '../ui';

/** 视觉批次 2 ⑥：空频道态示例提示——点击走既有 prefill 通道填入输入框（不自动发送）。
 *  文案按产品 agent 命名风格（pm-agent / dev-agent / reviewer-agent），仅作起点提示，用户可改 */
export const EMPTY_EXAMPLE_PROMPTS = [
  '@pm-agent 帮我拆解需求：',
  '@dev-agent 修复问题：',
  '@reviewer-agent 评审这段改动：',
];

interface ChannelStreamHeadProps {
  /** 首拉进行中（仅当 messages 为空时出骨架——已有消息时轮询/翻页不整屏替换） */
  loading: boolean;
  /** 首拉/兜底轮询失败（#482 三态分流：error 且空 → 错误态；已有消息不整屏替换） */
  error: string | null;
  /** messages.length === 0 */
  isEmpty: boolean;
  /** 错误态重试（走消息 refresh） */
  onRetry: () => void;
  /** 空态示例 chip 点击：经 prefill 通道填入输入框（不自动发送） */
  onPickExample: (text: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  completedCount: number;
  showCompleted: boolean;
  onToggleCompleted: (show: boolean) => void;
}

export const ChannelStreamHead = forwardRef<HTMLDivElement, ChannelStreamHeadProps>(
  function ChannelStreamHead({
    loading, error, isEmpty, onRetry, onPickExample,
    hasMore, onLoadMore, completedCount, showCompleted, onToggleCompleted,
  }, ref) {
    return (
      <div className="mc-stream-head" ref={ref}>
        {loading && isEmpty && (
          // 批次 F-3：消息流首拉骨架（批次 E-2 ui/Skeleton 正本）——消息行形态
          <SkeletonText lines={5} widths={['40%', '65%', '55%', '70%', '45%']} className="space-y-4 p-4" />
        )}
        {!loading && error && isEmpty && (
          // #482：首拉/兜底轮询失败——错误态 + 重试入口，与真空频道区分（原呈假空态，
          // 用户会把加载故障误判为空频道）；已有消息时轮询失败不整屏替换，消息流保留
          <div className="mc-stream-empty" role="alert">
            <p>消息加载失败</p>
            <button type="button" className="mc-empty-chip" onClick={onRetry}>重试</button>
          </div>
        )}
        {!loading && !error && isEmpty && (
          <div className="mc-stream-empty">
            <p>发送消息开始对话</p>
            <p>@Agent 提及 Agent 创建任务</p>
            {/* 视觉批次 2 ⑥：示例提示 chip——点击经既有 prefill 通道填入输入框（不自动发送），
                空态仅此一处渲染点（虚拟化/非虚拟化共用同一 .mc-stream 头块） */}
            <div className="mc-empty-examples">
              {EMPTY_EXAMPLE_PROMPTS.map(text => (
                <button
                  key={text}
                  type="button"
                  className="mc-empty-chip"
                  onClick={() => onPickExample(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* B2-002: Load more */}
        {hasMore && (
          <button onClick={onLoadMore} className="mc-loadmore">
            加载更早的消息
          </button>
        )}

        {/* B2-006: collapse completed toggle */}
        {!showCompleted && completedCount > 2 && (
          <button onClick={() => onToggleCompleted(true)} className="mc-collapse-toggle">
            显示 {completedCount - 2} 条已完成消息
          </button>
        )}
        {showCompleted && completedCount > 2 && (
          <button onClick={() => onToggleCompleted(false)} className="mc-collapse-toggle">
            收起已完成消息
          </button>
        )}
      </div>
    );
  },
);
