// 项目动态 — PMO 驾驶舱底部紧凑时间线
// 条目由 buildProjectTimeline（pipelineUtils）从 WU 时间戳 + deliveredAt 拼装，倒序 ≤20 条
import { useNavigate } from 'react-router-dom';
import { formatTimelineTime, type ProjectTimelineEntry } from './pipelineUtils';

const WU_STATUS_LABELS: Record<string, string> = {
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
  failed: '失败',
  completed: '已完成',
};

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
      return <span>{entry.actorName ?? 'agent'} 认领了 {title}</span>;
    case 'completed':
      return <span>{title} 完成（{WU_STATUS_LABELS[entry.status ?? ''] ?? entry.status}）</span>;
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
