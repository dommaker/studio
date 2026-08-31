// #394 频道动态右栏（spec §4.1–4.3，#381 定稿变体 B）——300px REQ 链路卡栏：
// 每 REQ 一卡（卡头 + 四站 stepper + PMO/Agent meta + 卡下最近动态），无归属动态落「其他动态」。
// 交互混合模型：REQ/WU → 就地右抽屉（onOpenReq/onOpenWu，不离开会话流）；
// PMO/Agent → ↗ 跳页（/pmo/project/:id、/agents/:roleId），PMO 数据链兜底，无则不渲染 badge（无死按钮）。
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { requirementApi, type Requirement, type RequirementChain } from '../../api/requirements';
import { channelApi, type ChannelMessage, type ChannelCurrentPmo } from '../../api/channel';
import { projectApi } from '../../api';
import { resolveAssignee, type AssigneeDisplay } from '../../hooks/useAssigneeDisplay';
import type { NeedInputTodo } from './ChannelNeedInputChip';
import {
  attributeActivity,
  buildChannelActivity,
  deriveChainSteps,
  fmtRelTime,
  type ChannelActivityItem,
} from './activityRail';

interface Props {
  channelId: string;
  reqs: Requirement[];
  messages: ChannelMessage[];
  waitingWus: NeedInputTodo[];
  onOpenWu: (wuId: string) => void;
  onOpenReq: (reqId: string) => void;
}

/** 每 REQ 拉一次 /requirements/:id/chain（stepper 计数 + WU→REQ 归属 + PMO 锚点）；失败静默略过该卡节点 */
function useReqChains(reqs: Requirement[]): Record<string, RequirementChain> {
  const [chains, setChains] = useState<Record<string, RequirementChain>>({});
  const idsKey = reqs.map(r => r.id).join(',');
  useEffect(() => {
    if (!idsKey) { setChains({}); return; }
    let alive = true;
    const list = idsKey.split(',');
    Promise.all(list.map(id =>
      requirementApi.getChain(id).then(r => r.data.data).catch(() => null),
    )).then(results => {
      if (!alive) return;
      const next: Record<string, RequirementChain> = {};
      results.forEach((c, i) => { if (c) next[list[i]] = c; });
      setChains(next);
    });
    return () => { alive = false; };
  }, [idsKey]);
  return chains;
}

/** 频道当前 PMO（PMO badge 兜底链末级；派生为 null 则不渲染 badge） */
function useCurrentPmo(channelId: string): ChannelCurrentPmo | null {
  const [pmo, setPmo] = useState<ChannelCurrentPmo | null>(null);
  useEffect(() => {
    let alive = true;
    channelApi.getCurrentPmo(channelId)
      .then(res => { if (alive) setPmo(res.data.data ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [channelId]);
  return pmo;
}

/** projectId → 展示名（PMO 号 · 标题）；拉不到（项目已删）→ 不进 map，调用方不渲染死按钮 */
function useProjectLabels(projectIds: string[]): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const idsKey = [...new Set(projectIds)].sort().join(',');
  useEffect(() => {
    if (!idsKey) { setLabels({}); return; }
    let alive = true;
    const list = idsKey.split(',');
    Promise.all(list.map(id =>
      projectApi.get(id)
        .then(r => {
          const p = r.data as { pmoNumber?: string; title?: string } | null;
          return p?.title ? `${p.pmoNumber ?? 'PMO'} · ${p.title}` : null;
        })
        .catch(() => null),
    )).then(results => {
      if (!alive) return;
      const next: Record<string, string> = {};
      results.forEach((label, i) => { if (label) next[list[i]] = label; });
      setLabels(next);
    });
    return () => { alive = false; };
  }, [idsKey]);
  return labels;
}

/** assigneeId → {name, roleId}（复用 #290 useAssigneeDisplay 同口径解析）；解析不到不进 map → 不渲染链接 */
function useAssigneeNames(assigneeIds: string[]): Record<string, AssigneeDisplay> {
  const [names, setNames] = useState<Record<string, AssigneeDisplay>>({});
  const idsKey = [...new Set(assigneeIds)].sort().join(',');
  useEffect(() => {
    if (!idsKey) { setNames({}); return; }
    let alive = true;
    const list = idsKey.split(',');
    Promise.all(list.map(id => resolveAssignee(id))).then(results => {
      if (!alive) return;
      const next: Record<string, AssigneeDisplay> = {};
      results.forEach((d, i) => { if (d) next[list[i]] = d; });
      setNames(next);
    });
    return () => { alive = false; };
  }, [idsKey]);
  return names;
}

/** 动态条目行：图标点（类型着色）+ 一行文 + 相对时间；REQ/WU → 就地抽屉 */
function ActivityRow({ item, onOpenWu, onOpenReq }: {
  item: ChannelActivityItem;
  onOpenWu: (wuId: string) => void;
  onOpenReq: (reqId: string) => void;
}) {
  const handleClick = () => {
    if (item.kind === 'req' && item.reqId) onOpenReq(item.reqId);
    else if (item.wuId) onOpenWu(item.wuId);
    else if (item.reqId) onOpenReq(item.reqId);
  };
  return (
    <button className="mc-act-row" onClick={handleClick} title={item.text}>
      <span className={`mc-act-dot mc-act-dot-${item.kind}`} />
      <span className="mc-act-text">{item.text}</span>
      <span className="mc-act-time">{item.pinned ? '待回复' : item.at ? fmtRelTime(item.at) : ''}</span>
    </button>
  );
}

export function ChannelActivityRail({ channelId, reqs, messages, waitingWus, onOpenWu, onOpenReq }: Props) {
  const navigate = useNavigate();
  const chains = useReqChains(reqs);
  const channelPmo = useCurrentPmo(channelId);

  // 卡级 PMO 数据链（§4.3）：chain.requirement.projectId 优先 → REQ 自身 projectId → 频道 current-pmo 兜底；
  // 都没有 → 不渲染 badge（无死按钮）
  const projectIdByReq = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of reqs) {
      m.set(r.id, chains[r.id]?.requirement.projectId ?? r.projectId ?? channelPmo?.id ?? null);
    }
    return m;
  }, [reqs, chains, channelPmo]);

  const allProjectIds = useMemo(
    () => [...projectIdByReq.values()].filter((x): x is string => !!x),
    [projectIdByReq],
  );
  const projectLabels = useProjectLabels(allProjectIds);

  const allAssigneeIds = useMemo(() => {
    const ids: string[] = [];
    for (const chain of Object.values(chains)) {
      for (const wu of chain.workunits) if (wu.assigneeId) ids.push(wu.assigneeId);
    }
    return ids;
  }, [chains]);
  const assigneeNames = useAssigneeNames(allAssigneeIds);

  // WU → REQ 归属映射（chain 加载后可用；加载前 WU 动态暂落「其他动态」，加载后归位）
  const wuToReq = useMemo(() => {
    const m = new Map<string, string>();
    for (const [reqId, chain] of Object.entries(chains)) {
      for (const wu of chain.workunits) m.set(wu.id, reqId);
    }
    return m;
  }, [chains]);

  const items = useMemo(
    () => buildChannelActivity({ messages, reqs, waitingWus }),
    [messages, reqs, waitingWus],
  );
  const attributed = useMemo(() => attributeActivity(items, wuToReq), [items, wuToReq]);

  return (
    <aside className="mc-act-rail" aria-label="频道动态">
      <div className="mc-act-rail-title">频道动态</div>
      <div className="mc-act-rail-body">
        {reqs.map(req => {
          const chain = chains[req.id];
          const wus = chain?.workunits ?? [];
          const steps = deriveChainSteps(req, wus);
          const projectId = projectIdByReq.get(req.id) ?? null;
          const assignees = [...new Set(wus.map(w => w.assigneeId).filter((x): x is string => !!x))];
          const cardActs = attributed.byReq[req.id] ?? [];
          return (
            <div className="mc-act-card" key={req.id}>
              <button className="mc-act-card-head" onClick={() => onOpenReq(req.id)}
                title={`${req.id} · ${req.title} · ${req.status}`}>
                <span className="mc-act-card-id">{req.id}</span>
                <span className="mc-act-card-title">{req.title}</span>
                <span className="mc-act-card-status">{req.status}</span>
              </button>
              {/* 四站 stepper：REQ/WU 站可点（就地抽屉）；连线随「已进入的阶段」着色 */}
              <div className="mc-act-stepper">
                {steps.map((s, i) => {
                  const stepClick = s.key === 'req'
                    ? () => onOpenReq(req.id)
                    : s.key === 'wu' && s.wuId
                      ? () => onOpenWu(s.wuId!)
                      : undefined;
                  const inner = (
                    <>
                      <span className="mc-act-step-dot" />
                      <span className="mc-act-step-label">{s.label}</span>
                    </>
                  );
                  return (
                    <Fragment key={s.key}>
                      {i > 0 && (
                        <span className={`mc-act-step-line${s.state !== 'upcoming' ? ' mc-act-step-line-reached' : ''}`} />
                      )}
                      {stepClick ? (
                        <button className={`mc-act-step mc-act-step-${s.state}`} onClick={stepClick}>{inner}</button>
                      ) : (
                        <span className={`mc-act-step mc-act-step-${s.state}`}>{inner}</span>
                      )}
                    </Fragment>
                  );
                })}
              </div>
              {(projectId && projectLabels[projectId]) || assignees.some(aid => assigneeNames[aid]) ? (
                <div className="mc-act-card-meta">
                  {/* 项目记录拉不到（已删）→ 不渲染 badge，避免死按钮 */}
                  {projectId && projectLabels[projectId] && (
                    <button className="mc-act-pmo-badge"
                      onClick={() => navigate(`/pmo/project/${projectId}`)}
                      title={projectLabels[projectId]}>
                      {projectLabels[projectId]} ↗
                    </button>
                  )}
                  {assignees.map(aid => assigneeNames[aid] && (
                    <button key={aid} className="mc-act-agent-link"
                      onClick={() => navigate(`/agents/${assigneeNames[aid].roleId}`)}
                      title={`Agent · ${assigneeNames[aid].name}`}>
                      @{assigneeNames[aid].name} ↗
                    </button>
                  ))}
                </div>
              ) : null}
              {cardActs.length > 0 && (
                <div className="mc-act-card-acts">
                  {cardActs.slice(0, 3).map(it => (
                    <ActivityRow key={it.id} item={it} onOpenWu={onOpenWu} onOpenReq={onOpenReq} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {attributed.other.length > 0 && (
          <>
            <div className="mc-act-group-label">其他动态</div>
            {attributed.other.map(it => (
              <ActivityRow key={it.id} item={it} onOpenWu={onOpenWu} onOpenReq={onOpenReq} />
            ))}
          </>
        )}
        {reqs.length === 0 && attributed.other.length === 0 && (
          <div className="mc-act-empty">暂无 REQ 与动态</div>
        )}
      </div>
    </aside>
  );
}
