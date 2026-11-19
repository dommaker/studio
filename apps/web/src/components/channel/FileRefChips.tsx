// FileRefChips（#691 自 ChannelInput 抽出）：#485 文件引用台账可视化——chip 可单独移除
// （只动台账不动正文路径文本，发送过滤自然不携带）；正文被编辑得不再含路径时标灰
// 「已失效」，不静默丢弃。
import type { FileRef } from '../../api/channel';
import { IconX } from '../ui/icons';
import { repoBasename } from './channelAutocompleteGroups';

interface Props {
  refs: FileRef[];
  /** 当前正文：判定引用失效（正文不含路径 → 发送时不会携带此引用） */
  content: string;
  onRemove: (ref: FileRef) => void;
}

export function FileRefChips({ refs, content, onRemove }: Props) {
  if (refs.length === 0) return null;
  return (
    <div className="mc-fileref-chips" aria-label="已引用的文件">
      {refs.map(ref => {
        const invalid = !content.includes(ref.path);
        return (
          <span
            key={`${ref.repo}:${ref.path}`}
            className={invalid ? 'mc-fileref-chip mc-fileref-chip-invalid' : 'mc-fileref-chip'}
            title={invalid ? '正文已不含该路径，发送时不会携带此引用' : `${ref.repo}/${ref.path}`}
          >
            <span className="mc-fileref-path">{ref.path}</span>
            <span className="mc-fileref-repo">{repoBasename(ref.repo)}</span>
            {invalid && <span className="mc-fileref-invalid-mark">已失效</span>}
            <button
              type="button"
              className="mc-icon-btn"
              aria-label={`移除引用 ${ref.path}`}
              onClick={() => onRemove(ref)}
            >
              <IconX />
            </button>
          </span>
        );
      })}
    </div>
  );
}
