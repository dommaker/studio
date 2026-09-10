// 进度管道 — PMO 驾驶舱核心区块：总进度条 + 六泳道 WU 小卡
// 数据：ProjectDetailPage 经 requirementApi.getChain + workunitApi.get 补全 + monitoringApi 名册组装
import { useNavigate } from 'react-router-dom';
import { deriveDisplayState, WU_STATUS_COLORS, WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import type { AgentInfo } from '../../api/monitoring';
import {
  computePipelineProgress,
  EVIDENCE_LAYER_LABELS,
  formatDuration,
  groupWorkUnitsByLane,
  type PipelineLane,
  type PipelineWorkUnit,
} from './pipelineUtils';
import { SkeletonText, SkeletonCard } from '../ui';

// #399 §8.3 词表正词：待领取/进行中/待验收/完成；#472 起文案/配色收口 wu-display 唯一出口（私有拷贝已删）。
// 泳道头/底色类与 chip 色同族（wu-display 的 chip 类是「底色+文字」双类，泳道拆成 head/lane 两类，故此处只留类骨架、文案同源）。
// pending 待确认走中性色（#472：与 in_review 待验收 warning 分开）。
const LANE_DEFS: Array<{ key: PipelineLane; label: string; headClass: string; laneClass: string }> = [
  { key: 'pending', label: WU_STATUS_LABELS.pending, headClass: 'u-text-2', laneClass: 'u-surface-2' },
  { key: 'unassigned', label: WU_STATUS_LABELS.unassigned, headClass: 'u-text-2', laneClass: 'u-surface-2' },
  { key: 'active', label: WU_STATUS_LABELS.active, headClass: 'u-accent', laneClass: 'u-accent-dim' },
  { key: 'in_review', label: WU_STATUS_LABELS.in_review, headClass: 'u-warn', laneClass: 'u-warn-dim' },
  { key: 'blocked', label: WU_STATUS_LABELS.blocked, headClass: 'u-err', laneClass: 'u-err-dim' },
  { key: 'done', label: WU_STATUS_LABELS.done, headClass: 'u-ok', laneClass: 'u-ok-dim' },
];

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
        <span className={`text-xs px-1.5 py-0.5 rounded ${WU_STATUS_COLORS[derived.column] ?? 'u-surface-2 u-text-2'}`}>
          {WU_STATUS_LABELS[derived.column] ?? derived.column}
        </span>
        {/* 证据徽章（§8.3 白话词表 EVIDENCE_LAYER_LABELS）：approved 亮绿，缺失灰底 */}
        {(['l1', 'l2', 'l3'] as const).map(key => (
          <span
            key={key}
            className={`text-xs px-1 py-0.5 rounded ${derived.evidence[key] ? 'u-ok-dim u-ok' : 'u-surface-2 u-text-3'}`}
          >
            {EVIDENCE_LAYER_LABELS[key]}{derived.evidence[key] ? '✓' : ''}
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
            className="u-accent truncate u-btn-reset"
          >
            {agent.name}
          </button>
        ) : (
          <span className="truncate">{wu.assigneeId ? `@${wu.assigneeId.slice(0, 8)}` : '未领取'}</span>
        )}
        {duration && <span className="flex-shrink-0">⏱ {duration}</span>}
      </div>
    </div>
  );
}

export function ProjectPipeline({ workunits, agents, loading }: Props) {
  if (loading) {
    // 批次 E-2：静态骨架占位（进度条行 + 泳道块形态，零动画）
    return (
      <div>
        <SkeletonText lines={1} widths={['60%']} className="mb-3" />
        <SkeletonCard height={96} />
      </div>
    );
  }
  const progress = computePipelineProgress(workunits);
  if (progress.total === 0) {
    return <div className="text-sm u-text-3">暂无任务产出</div>;
  }
  const lanes = groupWorkUnitsByLane(workunits);
  const agentById = new Map(agents.map(a => [a.id, a]));

  return (
    <div>
      {/* 总进度条（x/y 任务完成，workFinished 所有权口径） */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1">
          <div className="h-3 u-surface-2 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${progress.percent === 100 ? 'u-ok-bg' : 'u-accent-bg'}`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
        <span className="text-sm u-text-2 flex-shrink-0">
          {progress.finished}/{progress.total} 任务完成 · {progress.percent}%
        </span>
      </div>

      {/* 泳道（列数随 LANE_DEFS 实际泳道数对齐——#432 B0-1；泳道头计数 = 全页唯一状态计数表达；§8.1：0 桶 muted 自然呈现，不加整泳道染色） */}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${LANE_DEFS.length}, minmax(0, 1fr))` }}>
        {LANE_DEFS.map(lane => {
          const items = lanes[lane.key];
          const empty = items.length === 0;
          return (
            <div key={lane.key} className={`p-2 rounded-lg ${empty ? '' : lane.laneClass}`}>
              <div className={`text-xs mb-2 ${empty ? 'u-text-3' : lane.headClass}`}>
                {lane.label} ({items.length})
              </div>
              <div className="space-y-2">
                {items.map(wu => (
                  <WuCard key={wu.id} wu={wu} agent={wu.assigneeId ? agentById.get(wu.assigneeId) : undefined} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ProjectPipeline;
