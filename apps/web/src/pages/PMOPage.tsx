// PMOPage - PMO 管理主页面（项目 + OKR）
import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api, projectApi } from '../api';
import { channelApi, type Channel, type AgentProfile, type LocalProject } from '../api/channel';
import { requirementApi } from '../api/requirements';
import { knowledgeApi } from '../api/knowledge';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { toast } from '../utils/toast';
import { Select } from '../components/ui';

// 🆕 AS-016: 获取当前季度
function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** 容错解析 id 数组 JSON（历史数据可能双重编码）；非数组/损坏 → [] */
function parseIdArray(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    let v: unknown = JSON.parse(raw);
    if (typeof v === 'string') v = JSON.parse(v);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

interface KR {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  metricType?: string;
}

interface OKRObjective {
  id: string;
  title: string;
  description?: string;
}

interface OKR {
  id: string;
  title: string;
  quarter: string;
  status: string;
  progress: number;
  projectCount: number;
  objectives?: OKRObjective[];
  keyResults?: KR[];
}

const METRIC_TYPE_OPTIONS = [
  { value: '', label: '手动更新' },
  { value: 'pipeline_duration_p90', label: '管线耗时 (p90)' },
  { value: 'pipeline_duration_per_phase', label: '单阶段耗时' },
  { value: 'cache_hit_rate', label: '缓存命中率' },
  { value: 'execution_success_rate', label: '执行成功率' },
  { value: 'review_pass_rate', label: '审查通过率' },
  { value: 'token_saving_ratio', label: 'Token 节省率' },
];

// B8 Phase 1.5: metricType 元数据
const METRIC_META: Record<string, { unit: string; upperBound: number; baseline?: number }> = {
  '': { unit: '', upperBound: 100 },
  pipeline_duration_p90: { unit: 'min', upperBound: Infinity, baseline: 23 },
  pipeline_duration_per_phase: { unit: 'min', upperBound: Infinity },
  cache_hit_rate: { unit: '%', upperBound: 99.9, baseline: 94 },
  execution_success_rate: { unit: '%', upperBound: 100, baseline: 12 },
  review_pass_rate: { unit: '%', upperBound: 100 },
  token_saving_ratio: { unit: '%', upperBound: 90 },
};

interface KRValidation {
  status: 'pass' | 'warning' | 'blocked';
  reason: string;
}

function validateKRTarget(kr: KR): KRValidation {
  if (kr.target <= 0) return { status: 'blocked', reason: '目标必须大于 0' };
  if (!kr.metricType) return { status: 'pass', reason: '' };

  const meta = METRIC_META[kr.metricType];
  if (!meta) return { status: 'pass', reason: '' };

  // Baseline check: target below current level
  if (meta.baseline !== undefined && kr.target < meta.baseline) {
    return {
      status: 'blocked',
      reason: `目标 (${kr.target}${meta.unit}) 低于当前水平 (${meta.baseline}${meta.unit})。建议 >= ${Math.ceil(meta.baseline * 1.05)}${meta.unit}`,
    };
  }

  // Upper bound check: target too close to theoretical limit
  if (meta.upperBound !== Infinity && kr.target > meta.upperBound * 0.95) {
    return {
      status: 'warning',
      reason: `接近理论上限 (${meta.upperBound}${meta.unit})，可能不可实现`,
    };
  }

  // Gap check: target too far from baseline
  if (meta.baseline !== undefined && kr.target > meta.baseline * 3) {
    return {
      status: 'warning',
      reason: `距当前水平 (${meta.baseline}${meta.unit}) 差距大，建议分阶段`,
    };
  }

  return { status: 'pass', reason: '' };
}

interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description?: string;
  status: string;
  progress: number;
  createdAt: string;
  // 🆕 PMO-a: REQ 只读别名 / 交付策略 / 分支 / 杂务标记
  reqAlias?: string | null;
  deliveryPolicy?: string;
  gitBranch?: string | null;
  isChore?: boolean;
  OKR?: { id: string; title: string };
}

interface PMOPageProps {
  companyId?: string;
}

export function PMOPage({ companyId }: PMOPageProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [okrs, setOKRs] = useState<OKR[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // 🆕 AC-6: 卡片徽章数据（WU 完成度 / 文档计数；批量并行、失败静默不显示）
  const [wuStats, setWuStats] = useState<Record<string, { finished: number; total: number }>>({});
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});
  
  // 🆕 B8: OKR 创建弹窗 — 支持 KR 编辑
  const [showOKRDialog, setShowOKRDialog] = useState(false);
  const [newOKRTitle, setNewOKRTitle] = useState('');
  const [newOKRQuarter, setNewOKRQuarter] = useState(getCurrentQuarter());
  const [krs, setKRs] = useState<KR[]>([
    { id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' },
  ]);

  const addKR = () => {
    setKRs(prev => [...prev, {
      id: `kr${Date.now()}`,
      objectiveId: 'o1',
      title: '',
      target: 100,
      current: 0,
      unit: '%',
      metricType: '',
    }]);
  };

  const removeKR = (id: string) => {
    setKRs(prev => prev.filter(kr => kr.id !== id));
  };

  const updateKR = (id: string, field: keyof KR, value: string | number) => {
    setKRs(prev => prev.map(kr => kr.id === id ? { ...kr, [field]: value } : kr));
  };
  
  const tabParam = searchParams.get('tab');
  const defaultTab = tabParam === 'okr' ? 'okr' : 'projects';
  const [activeTab, setActiveTab] = useState<'projects' | 'okr'>(defaultTab);

  // AC-6: Publish dialog state
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishProjectId, setPublishProjectId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [publishing, setPublishing] = useState(false);
  // 发起弹窗：所选频道可响应的 Agent 成员（谁会认领一目了然；空 → 提前警示）
  const [channelAgents, setChannelAgents] = useState<AgentProfile[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // 🆕 PMO-a: 新建 PMO 弹窗（决策 2/4：deliveryPolicy 创建时选定，默认 branch-only）
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newRequirement, setNewRequirement] = useState('');
  const [newGitRepo, setNewGitRepo] = useState('');
  const [newDeliveryPolicy, setNewDeliveryPolicy] = useState<'branch-only' | 'auto-merge'>('branch-only');
  const [creating, setCreating] = useState(false);
  // 工程下拉：打开弹窗时实时扫描（与角色 CLI 扫描同一交互模式）
  const [discoveredProjects, setDiscoveredProjects] = useState<LocalProject[]>([]);
  const [projectsScanning, setProjectsScanning] = useState(false);
  const [projectsScanError, setProjectsScanError] = useState(false);

  useEffect(() => {
    loadData();
    loadChannels();
  }, [companyId]);

  // 🆕 AC-6: 列表加载后对可见项目批量并行查徽章数据（每项目一次 chain + 一次 knowledge；失败静默）
  useEffect(() => {
    if (projects.length === 0) {
      setWuStats({});
      setDocCounts({});
      return;
    }
    let cancelled = false;

    const withAlias = projects.filter((p): p is Project & { reqAlias: string } => !!p.reqAlias);
    Promise.allSettled(withAlias.map(async p => {
      const res = await requirementApi.getChain(p.reqAlias);
      const wus = res.data?.data?.workunits ?? [];
      // 完成口径 = workFinished 所有权口径（F6 铁律）
      const finished = wus.filter(w =>
        deriveDisplayState({ status: w.status, metadata: w.metadata }).workFinished).length;
      return { id: p.id, finished, total: wus.length };
    })).then(results => {
      if (cancelled) return;
      const next: Record<string, { finished: number; total: number }> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.id] = { finished: r.value.finished, total: r.value.total };
      }
      setWuStats(next);
    });

    Promise.allSettled(projects.map(async p => {
      const res = await knowledgeApi.listByProject(p.id);
      return { id: p.id, count: res.data?.documents?.length ?? 0 };
    })).then(results => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.id] = r.value.count;
      }
      setDocCounts(next);
    });

    return () => { cancelled = true; };
  }, [projects]);

  const loadData = async () => {
    try {
      setLoading(true);

      let actualCompanyId = companyId;
      if (!actualCompanyId) {
        const companiesRes = await api.get('/companies');
        if (companiesRes.data?.data?.length > 0) {
          actualCompanyId = companiesRes.data.data[0].id;
        }
      }

      const [okrRes, projectsRes] = await Promise.all([
        actualCompanyId
          ? api.get(`/pmo/okr?companyId=${actualCompanyId}`)
          : Promise.resolve({ data: { data: [] } }),
        actualCompanyId
          ? api.get(`/pmo/project?companyId=${actualCompanyId}&limit=20`)
          : Promise.resolve({ data: { data: [] } }),
      ]);

      setOKRs(okrRes.data?.data || []);
      setProjects(projectsRes.data?.data || []);
    } catch (err) {
      console.error('Failed to load PMO data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadChannels = async () => {
    try {
      const res = await channelApi.list();
      setChannels(res.data?.data || []);
    } catch {
      // best-effort: channels may not be available
    }
  };

  // 弹窗打开/切换频道时解析「谁会响应」：与 AgentLoop.observe 同一口径 ——
  // channel.members 非空 → 仅成员；为空（历史频道未回填）→ 回退 profile.channels（空 = 全频道可见）
  useEffect(() => {
    if (!showPublishDialog || !selectedChannelId) return;
    let cancelled = false;
    setAgentsLoading(true);
    channelApi.listAllAgents()
      .then(res => {
        if (cancelled) return;
        const active = (res.data?.data || []).filter(p => p.status === 'active' && p.name !== 'studio');
        const ch = channels.find(c => c.id === selectedChannelId);
        const memberIds = parseIdArray(ch?.members);
        const responders = memberIds.length > 0
          ? active.filter(p => memberIds.includes(p.id))
          : active.filter(p => {
              const chs = parseIdArray(typeof p.channels === 'string' ? p.channels : JSON.stringify(p.channels ?? []));
              return chs.length === 0 || chs.includes(selectedChannelId);
            });
        setChannelAgents(responders);
      })
      .catch(() => { if (!cancelled) setChannelAgents([]); })
      .finally(() => { if (!cancelled) setAgentsLoading(false); });
    return () => { cancelled = true; };
  }, [showPublishDialog, selectedChannelId, channels]);

  const handlePublishClick = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    setPublishProjectId(projectId);
    setSelectedChannelId(channels.length > 0 ? channels[0].id : '');
    setShowPublishDialog(true);
  };

  const handlePublishConfirm = async () => {
    if (!publishProjectId || !selectedChannelId) return;
    setPublishing(true);
    try {
      await projectApi.publish(publishProjectId, selectedChannelId);
      toast.success('已发起需求讨论');
      setShowPublishDialog(false);
      // 闭环：发起后直达频道，可看到需求消息与 agent 的实时回复
      navigate(`/channels/${selectedChannelId}`);
    } catch (err) {
      const msg = (err as Error).message || '发起失败';
      toast.error(msg);
    } finally {
      setPublishing(false);
    }
  };

  // 🆕 B8: 创建 OKR (支持 KR + metricType)
  const handleCreateOKR = async () => {
    if (!newOKRTitle.trim()) {
      toast.warning('请输入 OKR 标题');
      return;
    }
    // 验证 KR target > 0
    const invalidKR = krs.find(kr => kr.target <= 0);
    if (invalidKR) {
      toast.warning(`KR "${invalidKR.title || '未命名'}" 的目标值必须大于 0`);
      return;
    }

    try {
      const actualCompanyId = companyId || localStorage.getItem('companyId');
      if (!actualCompanyId) {
        toast.warning('请先选择公司');
        return;
      }

      await api.post('/pmo/okr', {
        companyId: actualCompanyId,
        title: newOKRTitle,
        quarter: newOKRQuarter,
        objectives: [{ id: 'o1', title: newOKRTitle }],
        keyResults: krs.filter(kr => kr.title.trim() !== ''),
      });

      setShowOKRDialog(false);
      setNewOKRTitle('');
      setKRs([{ id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' }]);
      loadData();
    } catch (err) {
      console.error('Failed to create OKR:', err);
      toast.error('创建 OKR 失败');
    }
  };

  // 工程扫描：打开新建弹窗时调 GET /projects/discover 取最新列表（服务端 60s 缓存）
  const loadDiscoveredProjects = async () => {
    setProjectsScanning(true);
    setProjectsScanError(false);
    try {
      const res = await channelApi.discoverProjects();
      setDiscoveredProjects(res.data?.data || []);
    } catch {
      setDiscoveredProjects([]);
      setProjectsScanError(true);
    } finally {
      setProjectsScanning(false);
    }
  };

  const handleOpenCreateForm = () => {
    setShowCreateForm(true);
    loadDiscoveredProjects();
  };

  // 🆕 PMO-a: 创建 PMO（companyId 由服务端解析；成功后刷新列表并清空表单）
  const handleCreateProject = async () => {
    if (!newTitle.trim()) {
      toast.warning('请输入标题');
      return;
    }
    setCreating(true);
    try {
      await projectApi.create({
        title: newTitle.trim(),
        requirement: newRequirement.trim() || undefined,
        gitRepo: newGitRepo.trim() || undefined,
        deliveryPolicy: newDeliveryPolicy,
      });
      toast.success('创建成功');
      setShowCreateForm(false);
      setNewTitle('');
      setNewRequirement('');
      setNewGitRepo('');
      setNewDeliveryPolicy('branch-only');
      loadData();
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || '创建 PMO 失败';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">📊 PMO 管理</h1>
            <p className="page-subtitle">项目组合 + OKR 管理</p>
          </div>
          <Link to="/" className="btn btn-secondary">
            ← 返回首页
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-8 py-4">
        <div className="flex gap-2 p-1 rounded" style={{ background: 'var(--bg-secondary)' }}>
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex-1 py-2 px-4 rounded text-sm font-medium ${activeTab === 'projects' ? 'u-surface u-accent' : 'u-text-2'}`}
          >
            📁 项目 ({projects.length})
          </button>
          <button
            onClick={() => setActiveTab('okr')}
            className={`flex-1 py-2 px-4 rounded text-sm font-medium ${activeTab === 'okr' ? 'u-surface u-accent' : 'u-text-2'}`}
          >
            🎯 OKR ({okrs.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 pb-8">
        {loading ? (
          <div className="text-center py-8 u-text-3">
            加载中...
          </div>
        ) : activeTab === 'projects' ? (
          <div className="space-y-3">
            {/* 🆕 PMO-a: 新建 PMO 入口（表单为规范 modal，见页面底部） */}
            <button
              onClick={handleOpenCreateForm}
              className="card w-full p-3 text-left cursor-pointer u-text-2"
              style={{ borderStyle: 'dashed' }}
            >
              <div className="flex items-center gap-2">
                <span>+ 新建 PMO</span>
              </div>
              <div className="text-xs mt-1 u-text-3">
                直接下达项目指令，自动生成 PMO 号
              </div>
            </button>

            {projects.length === 0 ? (
              <div className="text-center py-8 u-text-3">
                暂无项目，点击上方「新建 PMO」创建
              </div>
            ) : (
              projects.map(project => (
                <div
                  key={project.id}
                  className="card p-3 cursor-pointer"
                  onClick={() => navigate(`/pmo/project/${project.id}`)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="px-2 py-1 rounded text-sm font-bold u-accent-bg"
                      >
                        {project.pmoNumber}
                      </div>
                      <div>
                        <div className="font-medium flex items-center gap-2 u-text">
                          {project.title}
                          {/* 🆕 PMO-a: 杂务徽章 */}
                          {project.isChore && (
                            <span className="text-xs px-1.5 py-0.5 rounded u-warn-dim">
                              杂务
                            </span>
                          )}
                        </div>
                        <div className="text-xs u-text-3">
                          {project.description || '无描述'}
                          {/* 🆕 PMO-a: 交付策略小字标注 */}
                          {project.deliveryPolicy && (
                            <span className="ml-2">
                              · {project.deliveryPolicy}
                            </span>
                          )}
                          {/* 🆕 AC-6: WU 完成度 + 文档计数徽章（数据缺失/为 0 不显示） */}
                          {wuStats[project.id] && wuStats[project.id].total > 0 && (
                            <span className="ml-2 px-1.5 py-0.5 rounded u-surface-2 u-text-2">
                              WU {wuStats[project.id].finished}/{wuStats[project.id].total}
                            </span>
                          )}
                          {(docCounts[project.id] ?? 0) > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 rounded u-surface-2 u-text-2">
                              📄 {docCounts[project.id]}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-16 h-2 rounded-full u-surface-2">
                        <div
                          className="h-2 rounded-full u-ok-bg"
                          style={{ width: `${project.progress}%` }}
                        />
                      </div>
                      <span className="text-xs u-text-3">
                        {project.progress}%
                      </span>
                      {project.OKR && (
                        <span className="text-xs px-2 py-1 rounded u-accent-dim">
                          {project.OKR.title}
                        </span>
                      )}
                      {project.status === 'pending' && (
                        <button
                          onClick={(e) => handlePublishClick(e, project.id)}
                          disabled={channels.length === 0}
                          className="btn btn-primary btn-sm"
                          title={channels.length === 0 ? '无可用 Channel' : '选择频道，发起需求讨论'}
                        >
                          发起讨论
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* 🆕 AS-016: 创建 OKR 按钮（打开弹窗） */}
            <button
              onClick={() => setShowOKRDialog(true)}
              className="card w-full p-3 text-left cursor-pointer u-text-2"
              style={{ borderStyle: 'dashed' }}
            >
              <div className="flex items-center gap-2">
                <span>+ 创建 OKR</span>
              </div>
              <div className="text-xs mt-1 u-text-3">
                为新季度设置目标和关键结果
              </div>
            </button>

            {okrs.length === 0 ? (
              <div className="text-center py-8 u-text-3">
                暂无 OKR，点击上方按钮创建
              </div>
            ) : (
              okrs.map(okr => (
                <div
                  key={okr.id}
                  className="card p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium u-text">
                        {okr.title}
                      </div>
                      <div className="text-xs u-text-3">
                        {okr.quarter} · {okr.projectCount} 个项目
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-ok">
                          {Math.round(okr.progress * 100)}%
                        </div>
                        <div className="text-xs u-text-3">
                          进度
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* 🆕 B8: KR 列表 */}
                  {okr.keyResults && okr.keyResults.length > 0 && (
                    <div className="space-y-1 mt-2 pt-2 border-t u-border">
                      {okr.keyResults.map((kr: KR) => (
                        <div key={kr.id} className="flex items-center justify-between text-xs">
                          <span className="u-text-2">
                            {kr.title}
                            {kr.metricType && (
                              <span className="ml-1 px-1 py-0.5 rounded u-accent-dim" style={{ fontSize: 'var(--fs-xs)' }}>
                                auto
                              </span>
                            )}
                          </span>
                          <span className="font-mono u-text-3">
                            {kr.current}/{kr.target}{kr.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 🆕 B8: 创建 OKR 弹窗 (支持 KR 编辑) */}
      {showOKRDialog && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 672 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">创建 OKR</h2>
            </div>
            <div className="modal-body">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm u-text-2 mb-1">季度</label>
                  <input
                    type="text"
                    value={newOKRQuarter}
                    onChange={(e) => setNewOKRQuarter(e.target.value)}
                    className="input w-full"
                    placeholder="2026-Q3"
                  />
                </div>
                <div>
                  <label className="text-sm u-text-2 mb-1">标题</label>
                  <input
                    type="text"
                    value={newOKRTitle}
                    onChange={(e) => setNewOKRTitle(e.target.value)}
                    className="input w-full"
                    placeholder="管线效率提升 Q2"
                  />
                </div>
              </div>

              {/* 🆕 KR 编辑 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm u-text-2">关键结果 (KR)</label>
                  <button
                    onClick={addKR}
                    className="btn btn-secondary btn-sm"
                  >
                    + 添加 KR
                  </button>
                </div>
                {krs.map((kr, idx) => (
                  <div key={kr.id} className="p-3 rounded mb-2" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-bold u-text-3">
                        KR{idx + 1}
                      </span>
                      <input
                        type="text"
                        value={kr.title}
                        onChange={(e) => updateKR(kr.id, 'title', e.target.value)}
                        className="input flex-1"
                        placeholder="关键结果描述"
                      />
                      {krs.length > 1 && (
                        <button
                          onClick={() => removeKR(kr.id)}
                          className="text-xs u-err u-hover-text"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="text-xs u-text-3">目标值</label>
                        <input
                          type="number"
                          value={kr.target}
                          min={1}
                          onChange={(e) => updateKR(kr.id, 'target', Number(e.target.value))}
                          className="input w-full"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">当前值</label>
                        <input
                          type="number"
                          value={kr.current}
                          min={0}
                          onChange={(e) => updateKR(kr.id, 'current', Number(e.target.value))}
                          className="input w-full"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">单位</label>
                        <input
                          type="text"
                          value={kr.unit}
                          onChange={(e) => updateKR(kr.id, 'unit', e.target.value)}
                          className="input w-full"
                          placeholder="% / min / 次"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">自动度量</label>
                        <Select
                          value={kr.metricType || ''}
                          onChange={(v) => updateKR(kr.id, 'metricType', v)}
                          options={METRIC_TYPE_OPTIONS}
                          className="w-full"
                        />
                      </div>
                    </div>
                    {/* B8 Phase 1.5: inline validation */}
                    {kr.metricType && (() => {
                      const v = validateKRTarget(kr);
                      const meta = METRIC_META[kr.metricType];
                      if (v.status === 'pass' && !meta?.baseline) return null;
                      const colorClass = v.status === 'blocked' ? 'u-err' : v.status === 'warning' ? 'u-warn' : 'u-ok';
                      return (
                        <div className={`mt-2 text-xs ${colorClass}`}>
                          {meta?.baseline !== undefined && `基准: ${meta.baseline}${meta.unit}`}
                          {meta?.baseline !== undefined && v.status !== 'pass' && ' · '}
                          {v.status !== 'pass' ? v.reason : ''}
                          {v.status === 'pass' && meta?.baseline !== undefined && ` ✓ 目标合理`}
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            </div>
            </div>
            <div className="modal-footer">
              <button
                onClick={() => {
                  setShowOKRDialog(false);
                  setKRs([{ id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' }]);
                }}
                className="btn btn-secondary"
              >
                取消
              </button>
              <button
                onClick={handleCreateOKR}
                className="btn btn-primary"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 PMO-a: 新建 PMO 弹窗（style-guide §4.3 标准结构） */}
      {showCreateForm && (
        <div className="modal-overlay" onClick={() => setShowCreateForm(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">新建 PMO</h2>
              <button className="modal-close" onClick={() => setShowCreateForm(false)} aria-label="关闭">×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>标题 *</label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="input"
                    style={{ width: '100%' }}
                    placeholder="项目标题"
                  />
                </div>
                <div>
                  <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>需求描述</label>
                  <textarea
                    value={newRequirement}
                    onChange={(e) => setNewRequirement(e.target.value)}
                    className="input"
                    style={{ width: '100%', resize: 'none' }}
                    rows={3}
                    placeholder="需求背景、验收标准等"
                  />
                </div>
                <div>
                  <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>工程路径 (gitRepo)</label>
                  <Select
                    value={newGitRepo}
                    onChange={setNewGitRepo}
                    options={[
                      { value: '', label: '（不关联工程）' },
                      ...discoveredProjects.map(p => ({ value: p.path, label: `${p.name}（${p.path}）` })),
                    ]}
                    placeholder={projectsScanning ? '正在扫描本地工程…' : '选择扫描到的工程'}
                    disabled={projectsScanning}
                    aria-label="工程路径"
                    className="input"
                    style={{ width: '100%' }}
                  />
                  {projectsScanError && (
                    <div className="text-xs mt-1 u-text-3">
                      工程扫描失败（需要管理员权限）。
                      <button
                        onClick={loadDiscoveredProjects}
                        className="u-accent"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {!projectsScanning && !projectsScanError && discoveredProjects.length === 0 && (
                    <div className="text-xs mt-1 u-text-3">
                      未扫描到本地工程（检查 STUDIO_PROJECTS_ROOT 配置）
                    </div>
                  )}
                </div>
                <div>
                  <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>交付策略</label>
                  <Select
                    value={newDeliveryPolicy}
                    onChange={(v) => setNewDeliveryPolicy(v as 'branch-only' | 'auto-merge')}
                    options={[
                      { value: 'branch-only', label: '分支交付（不碰合并/发布）' },
                      { value: 'auto-merge', label: '自动合并（缺证据拒绝）' },
                    ]}
                    className="input"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateForm(false)} className="btn btn-secondary">
                取消
              </button>
              <button onClick={handleCreateProject} disabled={creating} className="btn btn-primary">
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AC-6: 发起需求讨论弹窗（选择目标频道） */}
      {showPublishDialog && (
        <div className="modal-overlay" onClick={() => setShowPublishDialog(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">发起需求讨论</h2>
              <button className="modal-close" onClick={() => setShowPublishDialog(false)} aria-label="关闭">×</button>
            </div>
            <div className="modal-body">
              {channels.length === 0 ? (
                <p className="u-text-3 text-sm">无可用 Channel，请先创建</p>
              ) : (
                <>
                  <Select
                    value={selectedChannelId}
                    onChange={setSelectedChannelId}
                    options={channels.map(ch => ({ value: ch.id, label: ch.name }))}
                    className="input"
                    style={{ width: '100%' }}
                  />
                  {agentsLoading ? (
                    <p className="u-text-3 text-sm" style={{ marginTop: 8 }}>加载频道成员…</p>
                  ) : channelAgents.length > 0 ? (
                    <p className="u-text-3 text-sm" style={{ marginTop: 8 }}>
                      会响应的 Agent（{channelAgents.length}）：{channelAgents.map(a => a.name).join('、')}
                      ——需求发到频道后由 TA 们认领并开始分析
                    </p>
                  ) : (
                    <p className="u-warn text-sm" style={{ marginTop: 8 }}>
                      ⚠ 该频道没有可响应的 Agent 成员，发起后需求可能无人认领；请先在频道里添加成员
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowPublishDialog(false)} className="btn btn-secondary">
                取消
              </button>
              <button
                onClick={handlePublishConfirm}
                disabled={publishing || channels.length === 0}
                className="btn btn-primary"
              >
                {publishing ? '发起中...' : '确认发起'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PMOPage;