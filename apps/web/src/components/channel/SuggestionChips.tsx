// SuggestionChips — #440 Phase 1：频道输入框上方的建议 prompt 片。
// 点击 → onPick(text)（由页面经 ChannelInput prefill 填入，不自动发送——人过目后按 Enter）；
// × dismiss 由调用方记账（会话级，key = wuId:column），本组件纯展示。
// 建议列表由 utils/wuSuggestions 静态映射产出（MVP），后端推导另开票。
import type { WuSuggestion } from '../../utils/wuSuggestions';

interface Props {
  suggestions: WuSuggestion[];
  onPick: (text: string) => void;
  onDismiss: () => void;
}

export function SuggestionChips({ suggestions, onPick, onDismiss }: Props) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mc-suggest" role="group" aria-label="下一步建议">
      {suggestions.map(s => (
        <button
          key={s.id}
          type="button"
          className="mc-suggest-chip"
          onClick={() => onPick(s.text)}
        >
          {s.label ?? s.text}
          {s.hint ? <span className="mc-suggest-hint">{s.hint}</span> : null}
        </button>
      ))}
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
