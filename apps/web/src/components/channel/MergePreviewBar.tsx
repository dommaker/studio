// MergePreviewBar（#691 自 ChannelInput 抽出）：#632 发送前归属预览条（复用 reply 预览条
// 容器/边框/淡色视觉）。三态：unique 显示并入目标 + 可切「新任务」/「纯消息」；ambiguous
// 淡提示多件在途（不显目标）；none 默认纯消息 + 可选「新任务」。chip 点击选中、再点回 auto
// （不发 intent）。拉取/防抖/复位状态机在 hooks/useMergePreview。
import type { MergeTargetPreview, SendIntent } from '../../api/channel';

interface Props {
  preview: MergeTargetPreview | null;
  /** useMergePreview.mergePreviewEligible——条件失效时即便残留 preview 也不渲染 */
  eligible: boolean;
  choice: 'auto' | SendIntent;
  onChoiceChange: (choice: 'auto' | SendIntent) => void;
}

export function MergePreviewBar({ preview, eligible, choice, onChoiceChange }: Props) {
  if (!preview || !eligible) return null;
  return (
    <div className="mc-input-reply mc-input-merge">
      {preview.status === 'unique' && (
        <>
          <span>⇄</span>
          <span>将并入：</span>
          <span className="mc-input-reply-content">{preview.workUnit?.title}</span>
        </>
      )}
      {preview.status === 'ambiguous' && (
        <span className="mc-input-merge-hint">频道有多件事同时进行，请回复对应消息或 @角色</span>
      )}
      {preview.status === 'none' && (
        <span className={choice === 'auto' ? 'mc-input-merge-default' : 'mc-input-merge-hint'}>纯消息</span>
      )}
      {(preview.status === 'unique' || preview.status === 'ambiguous' || preview.status === 'none') && (
        <>
          <button
            type="button"
            className={choice === 'new-task' ? 'mc-input-merge-chip mc-input-merge-chip-active' : 'mc-input-merge-chip'}
            aria-pressed={choice === 'new-task'}
            onClick={() => onChoiceChange(choice === 'new-task' ? 'auto' : 'new-task')}
          >
            新任务
          </button>
          {preview.status !== 'none' && (
            <button
              type="button"
              className={choice === 'plain' ? 'mc-input-merge-chip mc-input-merge-chip-active' : 'mc-input-merge-chip'}
              aria-pressed={choice === 'plain'}
              onClick={() => onChoiceChange(choice === 'plain' ? 'auto' : 'plain')}
            >
              纯消息
            </button>
          )}
        </>
      )}
    </div>
  );
}
