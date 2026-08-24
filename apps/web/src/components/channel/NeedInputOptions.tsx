// #267（决策 #250 D3）: NEED_INPUT 结构化选项卡 - meta.options[] 全仓首发落地。
// 选项按钮 + 「自定义…」（展开文本输入收路径直填）+ 「交给 agent 判断」；
// 点选即作为内嵌回复发送（走现有 replyTo -> resumeWaitingWorkUnit 通道，后端零改动）。
// multiSelect 为预留钩子：v1 恒单选，选中态一律 Set 持有、aria-multiselectable 透传，
// 未来开多选只改后端发字段 + 本组件 checkbox 语义，wire 与存储零迁移。
// #276（P2 #15）：disabled 透传--发送中禁用所有按钮防重复触发。
import { useState } from 'react';
import type { MetaOption } from '../../utils/messageMeta';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';

export const AGENT_JUDGE_LABEL = '交给 agent 判断';

interface Props {
  options: MetaOption[];
  /** #250 D3 预留多选钩子（v1 恒单选，点选即发送） */
  multiSelect?: boolean;
  /** #276：发送中禁用所有按钮防重复触发 */
  disabled?: boolean;
  /** 点选选项 / 自定义直填 / 交给 agent 判断 -- 内容作为内嵌回复发送；
   * #276：返回 Promise 以便父组件按真实成功置位 needSent（不发假承诺） */
  onReply: (content: string) => void | Promise<void>;
}

export function NeedInputOptions({ options, multiSelect, disabled, onReply }: Props) {
  // v1 单选：点选即发送；选中态 Set 持有，供未来 multiSelect 确认制复用
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  // #270：自定义输入框共享 composer 同款 IME 守卫
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  const pick = (opt: MetaOption) => {
    if (disabled) return;
    const key = opt.value ?? opt.label;
    setSelected(new Set([key]));
    onReply(key);
  };

  const sendCustom = () => {
    if (disabled) return;
    const trimmed = customDraft.trim();
    if (!trimmed) return;
    onReply(trimmed);
  };

  return (
    <div className="mc-need-options" role="listbox" aria-multiselectable={multiSelect || undefined}>
      {options.map(opt => {
        const key = opt.value ?? opt.label;
        return (
          <button
            key={key}
            role="option"
            aria-selected={selected.has(key)}
            className={`mc-need-option${selected.has(key) ? ' selected' : ''}`}
            onClick={() => pick(opt)}
            disabled={disabled}
          >
            <span className="mc-need-option-label">{opt.label}</span>
            {opt.description && <span className="mc-need-option-desc">{opt.description}</span>}
          </button>
        );
      })}
      <div className="mc-need-options-actions">
        {/* #276：展开/收起切换不受发送中限制（输入与发送仍禁用） */}
        <button className="mc-need-option-extra" onClick={() => setCustomOpen(v => !v)}>
          自定义…
        </button>
        <button className="mc-need-option-extra" onClick={() => onReply(AGENT_JUDGE_LABEL)} disabled={disabled}>
          {AGENT_JUDGE_LABEL}
        </button>
      </div>
      {customOpen && (
        <div className="mc-need-form">
          <input
            aria-label="自定义回复"
            placeholder="直接输入工程路径或说明…"
            value={customDraft}
            onChange={e => setCustomDraft(e.target.value)}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={e => {
              // #270：IME 选词 Enter 不发送；长按不连发
              if (e.key !== 'Enter' || isImeEvent(e) || e.repeat) return;
              sendCustom();
            }}
            disabled={disabled}
          />
          <button className="mc-btn mc-btn-primary" onClick={sendCustom} disabled={!customDraft.trim() || disabled}>
            回复
          </button>
        </div>
      )}
    </div>
  );
}
