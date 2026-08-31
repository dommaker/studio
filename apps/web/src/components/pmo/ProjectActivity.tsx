// 项目动态 — PMO 驾驶舱底部紧凑时间线
// 条目由 buildProjectTimeline（pipelineUtils）从 WU 时间戳 + deliveredAt 拼装，倒序 ≤20 条
import { useNavigate } from 'react-router-dom';
import { WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { formatTimelineTime, type ProjectTimelineEntry } from './pipelineUtils';

function EntryText({ entry }: { entry: ProjectTimelineEntry }) {
  const navigate = useNavigate();
  // WU 标题可点击 → WU 详情
  const title = entry.wuId ? (
    <button
      onClick={() => navigate(`/workunits/${entry.wuId}`)}
      className="u-accent"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
    >
      「{entry.title}」
    </button>
  ) : null;

  switch (entry.kind) {
    case 'created':
      return <span>新增 {title}</span>;
    case 'claimed':
      // #399 §8.3 词表：认领 → 领取
      return <span>{entry.actorName ?? 'agent'} 领取了 {title}</span>;
    case 'completed': {
      // #399 §8.3 词表：done/completed 正词即「完成」，与动词重复时不赘述；其他终结态保留区分（已关闭/失败）
      const label = WU_STATUS_LABELS[entry.status ?? ''] ?? entry.status;
      return <span>{title} 完成{label && label !== '已完成' ? `（${label}）` : ''}</span>;
    }
    case 'delivered':
      return <span className="u-ok">✓ 项目已交付</span>;
  }
}

export function ProjectActivity({ entries }: { entries: ProjectTimelineEntry[] }) {
  if (entries.length === 0) {
    return <div className="text-sm u-text-3">暂无动态</div>;
  }
  return (
    <ul className="space-y-1">
      {entries.map(entry => (
        <li key={entry.id} className="flex items-baseline gap-2 text-sm">
          <span className="text-xs u-text-3 flex-shrink-0">{formatTimelineTime(entry.at)}</span>
          <span className="u-text-2 min-w-0 truncate">
            <EntryText entry={entry} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default ProjectActivity;
