// #279（决策 #250 D4）：顶栏 NEED_INPUT 待办 chip。
// 只聚合 NEED_INPUT 等待（waitingForInput）——闸门类人审不阻塞执行，不聚合（避免红点焦虑）。
// chip 显示计数；点击展开下拉清单（WU 标识 + 问题摘要截断，全文入 title）；
// 点条目由父级滚动定位到该 WU 的当前提问消息并高亮。无待办不渲染。
import { useEffect, useRef, useState } from 'react';
import { shortWuId } from '../../utils/id';

export interface NeedInputTodo {
  wuId: string;
  /** metadata.waitingQuestion（agent 提问原文）；缺省回落 scope */
  question?: string;
  /** WU scope（question 缺失时的兜底摘要） */
  scope?: string;
}

interface Props {
  items: NeedInputTodo[];
  /** 点条目：滚动定位到该 WU 的当前提问消息并高亮 */
  onLocate: (wuId: string) => void;
}

/** 下拉问题摘要截断长度（全文由 title 承载） */
const QUESTION_SNIPPET_MAX = 40;

export function ChannelNeedInputChip({ items, onLocate }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击组件外部收起下拉（NotificationBell 同款模式）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="mc-need-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="mc-btn mc-need-chip"
        onClick={() => setOpen(v => !v)}
        title={`${items.length} 个 WorkUnit 等待你的回复`}
      >
        待回复 · {items.length}
      </button>
      {open && (
        <div className="mc-need-chip-dropdown" role="menu">
          {items.map(item => {
            const summary = item.question || item.scope || '';
            return (
              <button
                key={item.wuId}
                type="button"
                role="menuitem"
                className="mc-need-chip-item"
                title={summary || item.wuId}
                onClick={() => { setOpen(false); onLocate(item.wuId); }}
              >
                <span className="mc-need-chip-wu">{shortWuId(item.wuId)}</span>
                <span className="mc-need-chip-q">{summary.slice(0, QUESTION_SNIPPET_MAX)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
