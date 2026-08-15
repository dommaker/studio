// 进度管道 — PMO 驾驶舱核心区块：总进度条 + 五泳道 WU 小卡
// 数据：ProjectDetailPage 经 requirementApi.getChain + workunitApi.get 补全 + monitoringApi 名册组装
import { useNavigate } from 'react-router-dom';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import type { AgentInfo } from '../../api/monitoring';
import {
  computePipelineProgress,
  formatDuration,
  groupWorkUnitsByLane,
  type PipelineLane,
  type PipelineWorkUnit,
} from './pipelineUtils';

const LANE_DEFS: Array<{ key: PipelineLane; label: string; headClass: string; laneClass: string }> = [
  { key: 'pending', label: '待确认', headClass: 'u-warn', laneClass: 'u-warn-dim' },
  { key: 'unassigned', label: '待认领', headClass: 'u-text-2', laneClass: 'u-surface-2' },
  { key: 'active', label: '执行中', headClass: 'u-accent', laneClass: 'u-accent-dim' },
  { key: 'in_review', label: '评审中', headClass: 'u-warn', laneClass: 'u-warn-dim' },
  { key: 'blocked', label: '阻塞', headClass: 'u-err', laneClass: 'u-err-dim' },
  { key: 'done', label: '已完成', headClass: 'u-ok', laneClass: 'u-ok-dim' },
];

// 状态 chip 配色与 RequirementChainPanel / 任务看板一致
const STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'u-warn-dim u-warn',
  unassigned: 'u-surface-2 u-text-2',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

interface Props {
  workunits: PipelineWorkUnit[];
  /** monitoring 名册（assigneeId = instance id → name/roleId 解析） */
  agents: AgentInfo[];
  loading?: boolean;
}

function WuCard({ wu, agent }: { wu: PipelineWorkUnit; agent?: AgentInfo }) {
  const navigate = useNavigate();
  // F6 铁律：徽章/状态只读派生列
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });
  const duration = formatDuration(wu.claimedAt, wu.completedAt);
  return (
    <div
      className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg"
      onClick={() => navigate(`/workunits/${wu.id}`)}
    >
      <div className="font-medium truncate">{wu.title}</div>
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        {wu.type && (
          <span className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">{wu.type}</span>
        )}
        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[derived.column] ?? 'u-surface-2 u-text-2'}`}>
          {STATUS_LABELS[derived.column] ?? derived.column}
        </span>
        {/* L1/L2/L3 证据徽章：approved 亮绿，缺失灰底 */}
        {(['l1', 'l2', 'l3'] as const).map(level => (
          <span
            key={level}
            className={`text-xs px-1 py-0.5 rounded ${derived.evidence[level] ? 'u-ok-dim u-ok' : 'u-surface-2 u-text-3'}`}
          >
            {level.toUpperCase()}{derived.evidence[level] ? '✓' : ''}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-1 mt-1 text-xs u-text-3">
        {agent ? (
          <button
            onClick={e => {
              e.stopPropagation();
              navigate(`/agents/${agent.roleId}`);
            }}
            className="u-accent truncate"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
          >
            {agent.name}
          </button>
        ) : (
          <span className="truncate">{wu.assigneeId ? `@${wu.assigneeId.slice(0, 8)}` : '未认领'}</span>
        )}
        {duration && <span className="flex-shrink-0">⏱ {duration}</span>}
      </div>
    </div>
  );
}

export function ProjectPipeline({ workunits, agents, loading }: Props) {
  if (loading) {
    return <div className="text-sm u-text-3">加载中...</div>;
  }
  const progress = computePipelineProgress(workunits);
  if (progress.total === 0) {
    return <div className="text-sm u-text-3">暂无 WorkUnit 产出</div>;
  }
  const lanes = groupWorkUnitsByLane(workunits);
  const agentById = new Map(agents.map(a => [a.id, a]));

  return (
    <div>
      {/* 总进度条（x/y WU 完成，workFinished 所有权口径） */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1">
          <div className="h-3 u-surface-2 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${progress.percent === 100 ? 'u-ok-bg' : 'bg-gradient-to-r from-blue-400 to-blue-600'}`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
        <span className="text-sm u-text-2 flex-shrink-0">
          {progress.finished}/{progress.total} WU 完成 · {progress.percent}%
        </span>
      </div>

      {/* 五泳道 */}
      <div className="grid grid-cols-5 gap-2">
        {LANE_DEFS.map(lane => (
          <div key={lane.key} className={`p-2 rounded-lg ${lane.laneClass}`}>
            <div className={`text-xs mb-2 ${lane.headClass}`}>
              {lane.label} ({lanes[lane.key].length})
            </div>
            <div className="space-y-2">
              {lanes[lane.key].map(wu => (
                <WuCard key={wu.id} wu={wu} agent={wu.assigneeId ? agentById.get(wu.assigneeId) : undefined} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ProjectPipeline;
