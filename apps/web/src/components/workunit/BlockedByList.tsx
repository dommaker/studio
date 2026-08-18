// #116: 依赖（metadata.blockedBy）清单共享组件 — WorkUnitListPage 被阻塞行展开 / WorkUnitDetailPage「依赖与验收」卡复用。
// 文案不用行话（#53/#74 偏好）：blockedBy = 依赖。了结口径 = done/closed（#109，与服务端 wu-dependencies 同口径）；
// 拉不到的依赖（已删/笔误）显示「找不到这张单」并按未了结样式展示（保守阻塞口径，人工修正 metadata 即解锁）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { workunitApi } from '../../api/workunit';
import { DEP_STATUS_LABEL, parseBlockedBy } from '../pmo/mapUtils';

/** 了结口径（#109）：done/closed 终态才算了结；其余（含拉取失败）一律未了结 */
const FINISHED = new Set(['done', 'closed']);

interface DepRow {
  id: string;
  title: string;
  /** null = 拉取失败（已删/笔误），按未了结展示 */
  status: string | null;
}

export function BlockedByList({ metadata }: { metadata: string | null }) {
  const ids = parseBlockedBy(metadata);
  const [deps, setDeps] = useState<DepRow[]>([]);

  // metadata 切换时在渲染期同步清空旧行（同 WorkUnitDetailPage prevId 模式），避免残留至新拉取落定
  const [prevMetadata, setPrevMetadata] = useState(metadata);
  if (prevMetadata !== metadata) {
    setPrevMetadata(metadata);
    setDeps([]);
  }

  useEffect(() => {
    const depIds = parseBlockedBy(metadata);
    if (depIds.length === 0) return;
    let alive = true;
    // 依赖状态逐个 best-effort 拉取（后端无批量接口；数量受 blockedBy 清单约束，实践为个位数）
    Promise.allSettled(depIds.map(id => workunitApi.get(id))).then(results => {
      if (!alive) return;
      setDeps(results.map((r, i) => {
        if (r.status !== 'fulfilled') return { id: depIds[i], title: depIds[i], status: null };
        const wu = r.value.data;
        let title = wu.scope;
        try {
          const m = JSON.parse(wu.metadata || '{}') as { title?: unknown };
          if (typeof m.title === 'string' && m.title) title = m.title;
        } catch { /* 坏 JSON 回退 scope */ }
        return { id: depIds[i], title, status: typeof wu.status === 'string' ? wu.status : null };
      }));
    });
    return () => { alive = false; };
  }, [metadata]);

  if (ids.length === 0) return null;

  return (
    <div>
      <span className="text-xs u-text-2">依赖（{ids.length}）</span>
      <div className="mt-1 space-y-1">
        {deps.map(d => {
          const finished = d.status !== null && FINISHED.has(d.status);
          return (
            <div key={d.id} className="flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded flex-shrink-0 ${finished ? 'u-ok-dim u-ok' : 'u-warn-dim u-warn'}`}>
                {d.status === null ? '找不到这张单' : DEP_STATUS_LABEL[d.status] ?? d.status}
              </span>
              <Link
                to={`/workunits/${d.id}`}
                className="u-text u-hover-accent truncate"
                title={`打开依赖 WorkUnit 详情页（${d.id}）`}
                onClick={e => e.stopPropagation()}
              >
                {d.title}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
