// ProjectMap — PMO 地图区（#114 T8，#106 子票）
// 目标 / 待决问题清单（状态徽章）/ 结论时间线（点进决策单）/ 任务单依赖图。
// 同文件附 NextActionCard（顶部「下一个该干什么」）。口径与排序细则见 mapUtils.ts。
// UI 文案不用行话（#53/#74）：fog=待决问题、blockedBy=依赖、decision=决策单。

import { useNavigate } from 'react-router-dom';
import {
  FOG_BADGE_META,
  DEP_STATUS_LABEL,
  resolveFogBadge,
  buildTaskDepRows,
  type PmoMap,
  type NextActionCandidate,
} from './mapUtils';
import { formatTimelineTime } from './pipelineUtils';

interface ProjectMapProps {
  map: PmoMap;
  /** 决策单状态：fog.wuId → WU status（页面 best-effort 逐个拉取；拉不到按待认领兜底） */
  decisionStatusByWuId: Record<string, string>;
  /** REQ 链路 WU（依赖图数据源，chain 已按创建时间升序） */
  chainWus: Array<{ id: string; title: string; status: string; metadata?: string | null }>;
}

export function ProjectMap({ map, decisionStatusByWuId, chainWus }: ProjectMapProps) {
  const navigate = useNavigate();
  const depRows = buildTaskDepRows(chainWus);
  // 结论时间线：按落地时间正序（最早的在上面，读起来是决策演进史）
  const decisions = [...map.decisions].sort(
    (a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt),
  );

  return (
    <div>
      {/* 目标 */}
      <div className="mb-4">
        <div className="mc-card-label mb-1">🎯 目标</div>
        <div className="text-sm u-text-1">{map.destination}</div>
      </div>

      {/* 待决问题清单（状态徽章四态：待认领/讨论中/待确认/已定） */}
      <div className="mb-4">
        <div className="mc-card-label mb-2">❓ 待决问题 ({map.fog.length})</div>
        {map.fog.length === 0 ? (
          <div className="text-sm u-text-3">暂无待决问题</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {map.fog.map(item => {
              const badge = resolveFogBadge(item, item.wuId ? decisionStatusByWuId[item.wuId] : undefined);
              const meta = FOG_BADGE_META[badge];
              return (
                <li key={item.id} className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${meta.className}`}>{meta.label}</span>
                  {item.wuId ? (
                    <button
                      onClick={() => navigate(`/workunits/${item.wuId}`)}
                      className="text-sm u-text-1 u-hover-bg"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left' }}
                    >
                      {item.question}
                    </button>
                  ) : (
                    <span className="text-sm u-text-1">{item.question}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 结论时间线（可点进决策单线程） */}
      <div className="mb-4">
        <div className="mc-card-label mb-2">📜 结论时间线 ({decisions.length})</div>
        {decisions.length === 0 ? (
          <div className="text-sm u-text-3">还没有拍板的结论</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {decisions.map(d => (
              <li key={d.wuId} className="flex items-baseline gap-2">
                <span className="text-xs u-text-3" style={{ flexShrink: 0 }}>{formatTimelineTime(d.resolvedAt)}</span>
                <button
                  onClick={() => navigate(`/workunits/${d.wuId}`)}
                  className="text-sm u-text-1 u-hover-bg"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left' }}
                >
                  {d.summary || '（未填写结论）'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 任务单依赖图（只列有依赖的单；依赖已清的单才会出现在「下一个该干什么」） */}
      <div>
        <div className="mc-card-label mb-2">🔗 任务单依赖</div>
        {depRows.length === 0 ? (
          <div className="text-sm u-text-3">任务单之间暂无依赖</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {depRows.map(row => (
              <li key={row.id}>
                <button
                  onClick={() => navigate(`/workunits/${row.id}`)}
                  className="text-sm u-text-1 u-hover-bg"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                >
                  {row.title}
                </button>
                <span className="text-xs u-text-3">（{DEP_STATUS_LABEL[row.status] ?? row.status}）</span>
                <div className="text-xs u-text-2 mt-1" style={{ paddingLeft: 12 }}>
                  等：{row.deps.map(dep => (
                    <span key={dep.id} className="mr-2">
                      {dep.title ?? `${dep.id.slice(0, 8)}…`}
                      {dep.status
                        ? `（${DEP_STATUS_LABEL[dep.status] ?? dep.status}）`
                        : '（找不到这张单）'}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * 顶部「下一个该干什么」：可认领 + 依赖已清的第一张（排序细则见 mapUtils.pickNextAction）。
 * action=null = 暂无（依赖未清或都已有人在做）。
 */
export function NextActionCard({ action }: { action: NextActionCandidate | null }) {
  const navigate = useNavigate();
  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-2">👉 下一个该干什么</h3>
      {action ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => navigate(`/workunits/${action.id}`)}
            className="text-sm u-accent u-hover-bg"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
          >
            {action.title}
          </button>
          <span className="text-xs u-text-3">
            {action.type === 'decision' ? '先拍板这个待决问题' : '可以认领开工'}
          </span>
        </div>
      ) : (
        <div className="text-sm u-text-3">暂无可认领的任务（依赖未清或都已有人在做）</div>
      )}
    </div>
  );
}
