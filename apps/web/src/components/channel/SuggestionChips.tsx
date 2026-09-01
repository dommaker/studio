// SuggestionChips — #440 Phase 1：频道输入框上方的建议片；
// #443（spec #441）扩为三形态渲染骨架：
//   status（只读状况说明，非按钮、点击无发送语义）/ action（确定性动作，点击走 onAction
//   直调后端，不经输入框——#444 起由后端产出「补派评审」）/ prompt（缺省；点击 → onPick(text)
//   预填，由页面经 ChannelInput prefill 填入，不自动发送——人过目后按 Enter）。
// × dismiss 由调用方记账（会话级），本组件纯展示。
// 数据来源：唯一来源 = 端点派生建议（GET /channels/:id/suggestions，经 suggestionCopy 模板渲染）；
// #440 静态映射（wuSuggestions）已于 #447 删除，组件本身不感知来源。

/** 引导片条目：三形态并集（kind 缺省 = prompt） */
export interface SuggestionChipItem {
  id: string;
  /** 缺省 = prompt */
  kind?: 'status' | 'action' | 'prompt';
  /** prompt 形态：点击后预填进输入框的内容（发给 agent 的指令本体），不被展示文案污染 */
  text?: string;
  /** 片上展示文案（缺省 = text） */
  label?: string;
  /** 片内说明小字（可选语义 / 点击后果 / 无需操作说明），说人话、无内部术语 */
  hint?: string;
}

interface Props {
  suggestions: SuggestionChipItem[];
  onPick: (text: string) => void;
  /** action 形态点击（直调确定性接口骨架）；无产出方时可不传（#444 已接线补派评审） */
  onAction?: (item: SuggestionChipItem) => void;
  onDismiss: () => void;
}

export function SuggestionChips({ suggestions, onPick, onAction, onDismiss }: Props) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mc-suggest" role="group" aria-label="下一步建议">
      {suggestions.map(s => {
        const label = s.label ?? s.text ?? '';
        if (s.kind === 'status') {
          // 只读状况说明：非交互元素，无点击语义（自动化在途，安心等待）
          return (
            <span key={s.id} role="status" className="mc-suggest-chip mc-suggest-status">
              {label}
              {s.hint ? <span className="mc-suggest-hint">{s.hint}</span> : null}
            </span>
          );
        }
        if (s.kind === 'action') {
          return (
            <button
              key={s.id}
              type="button"
              className="mc-suggest-chip"
              onClick={() => onAction?.(s)}
            >
              {label}
              {s.hint ? <span className="mc-suggest-hint">{s.hint}</span> : null}
            </button>
          );
        }
        // prompt 形态（缺省）：无预填文本不出（fail-closed，不点空指令）
        if (s.text === undefined) return null;
        const text = s.text;
        return (
          <button
            key={s.id}
            type="button"
            className="mc-suggest-chip"
            onClick={() => onPick(text)}
          >
            {label}
            {s.hint ? <span className="mc-suggest-hint">{s.hint}</span> : null}
          </button>
        );
      })}
      <button
        type="button"
        className="mc-icon-btn mc-suggest-dismiss"
        aria-label="关闭建议"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
