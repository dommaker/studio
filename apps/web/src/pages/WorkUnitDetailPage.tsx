// WorkUnitDetailPage — /workunits/:id WU 详情页（全站跳转枢纽，2026-07 agents-pmo-flow-ux §5.4）
// 自上而下：Header（类型+状态+标题+时间+failureType）→ 归属条（PMO/REQ/频道/认领 agent 四回跳）
// → 证据台账 L1/L2/L3（与 WorkUnitDrawer 同一数据路径：deriveDisplayState / parseAttestations）
// → 执行过程（复用 ExecutionSteps，自带 REST 回放 + 实时流）→ 讨论区（复用 DiscussionPanel）
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { requirementApi } from '../api/requirements';
import { projectApi } from '../api/index';
import { channelApi } from '../api/channel';
import { monitoringApi } from '../api/monitoring';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { DiscussionPanel } from '../components/DiscussionPanel';
import { RequirementChainPanel } from '../components/requirement/RequirementChainPanel';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';

const statusLabels: Record<string, string> = {
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const statusColors: Record<string, string> = {
  unassigned: 'u-surface-2 u-text-3',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

const typeLabels: Record<string, string> = {
  task: '任务',
  monitor: '监控',
  analysis: '分析',
  discussion: '讨论',
};

interface PmoInfo {
  id: string;
  pmoNumber: string;
  title: string;
}

function parseMeta(metadata: string | null): Record<string, unknown> {
  try { return JSON.parse(metadata || '{}') as Record<string, unknown>; } catch { return {}; }
}

/** 归属条 PMO 解析：① metadata.pmoProjectId 直查；② 否则 reqId → requirement.projectId（REQ 别名视图 projectId = PMO 自身 id） */
async function resolvePmo(wu: WorkUnit): Promise<PmoInfo | null> {
  const metaPmoId = parseMeta(wu.metadata).pmoProjectId;
  let projectId = typeof metaPmoId === 'string' ? metaPmoId : null;
  if (!projectId && wu.reqId) {
    try {
      const reqRes = await requirementApi.get(wu.reqId);
      projectId = reqRes.data.data.projectId ?? null;
    } catch { return null; }
  }
  if (!projectId) return null;
  try {
    const res = await projectApi.get(projectId);
    const p = res.data as { id?: unknown; pmoNumber?: unknown; title?: unknown };
    if (typeof p.id !== 'string' || typeof p.pmoNumber !== 'string') return null;
    return { id: p.id, pmoNumber: p.pmoNumber, title: typeof p.title === 'string' ? p.title : '' };
  } catch { return null; }
}

export function WorkUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [wu, setWu] = useState<WorkUnit | null>(null);
  const [error, setError] = useState('');
  const [pmo, setPmo] = useState<PmoInfo | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<{ name: string; roleId: string } | null>(null);
  const [chainReqId, setChainReqId] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setWu(null);
    setError('');
    setPmo(null);
    setChannelName(null);
    setAssignee(null);
    workunitApi.get(id)
      .then(r => {
        if (!alive) return;
        const unit = r.data;
        setWu(unit);
        // 归属解析全部 best-effort 并行：解析不到就不显示对应 chip，不阻塞页面
        resolvePmo(unit).then(p => { if (alive) setPmo(p); });
        if (unit.channelId) {
          channelApi.list()
            .then(res => {
              if (!alive) return;
              setChannelName(res.data.data.find(c => c.id === unit.channelId)?.name ?? null);
            })
            .catch(() => { /* best-effort */ });
        }
        if (unit.assigneeId) {
          // assigneeId 是 instance id：按 id 匹配 /monitoring/agents 拿角色名与 roleId
          monitoringApi.getAgentSummary()
            .then(res => {
              if (!alive) return;
              const a = res.data.agents.find(a => a.id === unit.assigneeId);
              setAssignee(a ? { name: a.name, roleId: a.roleId } : null);
            })
            .catch(() => { /* best-effort */ });
        }
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id]);

  const handleBack = () => {
    // 有站内历史则后退，否则回 /workunits（深链直达场景）
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate('/workunits');
  };

  const meta = wu ? parseMeta(wu.metadata) : {};
  const title = wu ? (typeof meta.title === 'string' && meta.title ? meta.title : wu.scope) : '';
  // F6 派生（铁律：徽章/证据判断一律过 deriveDisplayState，不自行解释 attestations）
  const derived = wu ? deriveDisplayState({ status: wu.status, metadata: wu.metadata }) : null;
  const attestations = wu ? parseAttestations(wu.metadata) : undefined;

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            {wu && derived && (
              <>
                <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2 flex-shrink-0">
                  {typeLabels[wu.type] ?? wu.type}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${statusColors[derived.column] || 'u-surface-2 u-text-3'}`}>
                  {statusLabels[derived.column] ?? derived.column}
                </span>
                <SelfReviewBadge wu={wu} />
              </>
            )}
            <h1 className="page-title truncate">{wu ? title : 'WorkUnit 详情'}</h1>
          </div>
          <button className="btn btn-secondary flex-shrink-0" onClick={handleBack}>返回</button>
        </div>
        {wu && (
          <p className="page-subtitle">
            创建 {formatTime(wu.createdAt)}
            {wu.claimedAt && ` · 认领 ${formatTime(wu.claimedAt)}`}
            {wu.completedAt && ` · 完成 ${formatTime(wu.completedAt)}`}
          </p>
        )}
        {wu?.failureType && (
          <div className="mt-2 text-xs u-err">失败类型：{wu.failureType}</div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error ? (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">加载失败: {error}</div>
          ) : !wu || !derived ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : (
            <>
              {/* 归属条（核心，四个跳转） */}
              {(pmo || wu.reqId || wu.channelId || wu.assigneeId) && (
                <div
                  className="mt-4 p-3 rounded-lg flex items-center gap-2 flex-wrap"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
                >
                  <span className="text-xs u-text-3">归属</span>
                  {pmo && (
                    <Link
                      to={`/pmo/project/${pmo.id}`}
                      className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent u-hover-bg"
                      title="所属 PMO 项目"
                    >
                      {pmo.pmoNumber} · {pmo.title}
                    </Link>
                  )}
                  {wu.reqId && (
                    <button
                      className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent u-hover-bg"
                      title="查看 REQ 全链路"
                      onClick={() => setChainReqId(wu.reqId ?? null)}
                    >
                      {wu.reqId}
                    </button>
                  )}
                  {wu.channelId && (
                    <Link
                      to={`/channels/${wu.channelId}`}
                      className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3 u-hover-bg"
                      title="所在频道"
                    >
                      # {channelName ?? `${wu.channelId.slice(0, 8)}...`}
                    </Link>
                  )}
                  {wu.assigneeId && (
                    assignee ? (
                      <Link
                        to={`/agents/${assignee.roleId}`}
                        className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3 u-hover-bg"
                        title="认领 Agent"
                      >
                        @{assignee.name}
                      </Link>
                    ) : (
                      <span
                        className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                        title="认领 Agent（实例不在当前运行列表，无法定位角色）"
                      >
                        @{wu.assigneeId.slice(0, 8)}
                      </span>
                    )
                  )}
                </div>
              )}

              {/* F6 证据台账：L1 自动验证 / L2 Agent 评审 / L3 人工验收（数据路径同 WorkUnitDrawer） */}
              <div
                className="mt-4 p-3 rounded-lg"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-xs font-medium u-text-2 mb-2">证据台账</div>
                {attestations === undefined ? (
                  <div className="text-xs u-text-3">存量 WU，证据模型未介入（按存储状态展示）</div>
                ) : (
                  <div className="space-y-1.5">
                    {(['l1', 'l2', 'l3'] as const).map(level => {
                      const entry = attestations[level];
                      const label = level === 'l1' ? 'L1 自动验证' : level === 'l2' ? 'L2 Agent 评审' : 'L3 人工验收';
                      return (
                        <div className="flex items-center gap-2 text-xs" key={level}>
                          <span className="u-text-2 w-24 flex-shrink-0">{label}</span>
                          {entry ? (
                            <>
                              <span className={`px-2 py-0.5 rounded ${entry.verdict === 'approved' ? 'u-ok-dim u-ok' : 'u-err-dim u-err'}`}>
                                {entry.verdict === 'approved' ? '✓ 通过' : '✗ 拒绝'}
                              </span>
                              <span className="u-text-3">
                                {entry.kind} · {entry.by.slice(0, 8)} · {formatTime(entry.at)}
                              </span>
                            </>
                          ) : (
                            <span className="u-text-3">—</span>
                          )}
                        </div>
                      );
                    })}
                    {attestations.l2?.summary && (
                      <div className="text-xs u-text-3">评审结论：{attestations.l2.summary}</div>
                    )}
                  </div>
                )}
              </div>

              {/* 执行过程（思考/工具调用/用量；组件自带 REST 回放 + SSE 实时流，页面不接 SSE） */}
              <div
                className="mt-4 p-3 rounded-lg"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
              >
                <ExecutionSteps workUnitId={wu.id} />
              </div>

              {/* 讨论区（WU 级消息，无需频道上下文） */}
              <DiscussionPanel workUnitId={wu.id} />
            </>
          )}
        </div>
      </div>

      {/* REQ 全链路弹窗（复用 RequirementChainPanel） */}
      {chainReqId && <RequirementChainPanel reqId={chainReqId} onClose={() => setChainReqId(null)} />}
    </div>
  );
}

function formatTime(ts: string | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
