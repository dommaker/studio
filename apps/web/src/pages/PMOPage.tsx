// PMOPage - PMO 管理主页面（项目 + OKR）
import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api, projectApi } from '../api';
import { channelApi, type Channel, type AgentProfile, type LocalProject } from '../api/channel';
import { requirementApi } from '../api/requirements';
import { knowledgeApi } from '../api/knowledge';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { toast } from '../utils/toast';
import type { KR, OKR, Project } from '../components/pmo/types';
import { getCurrentQuarter } from '../components/pmo/okrUtils';
import { CreateOKRDialog } from '../components/pmo/CreateOKRDialog';
import { CreatePMODialog } from '../components/pmo/CreatePMODialog';
import { PublishProjectDialog } from '../components/pmo/PublishProjectDialog';
import { ProjectCard } from '../components/pmo/ProjectCard';
import { OKRCard } from '../components/pmo/OKRCard';

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
                <ProjectCard
                  key={project.id}
                  project={project}
                  wuStats={wuStats}
                  docCounts={docCounts}
                  channels={channels}
                  handlePublishClick={handlePublishClick}
                />
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
                <OKRCard key={okr.id} okr={okr} />
              ))
            )}
          </div>
        )}
      </div>

      {showOKRDialog && (
        <CreateOKRDialog
          newOKRQuarter={newOKRQuarter}
          setNewOKRQuarter={setNewOKRQuarter}
          newOKRTitle={newOKRTitle}
          setNewOKRTitle={setNewOKRTitle}
          krs={krs}
          setKRs={setKRs}
          addKR={addKR}
          removeKR={removeKR}
          updateKR={updateKR}
          setShowOKRDialog={setShowOKRDialog}
          handleCreateOKR={handleCreateOKR}
        />
      )}

      {showCreateForm && (
        <CreatePMODialog
          newTitle={newTitle}
          setNewTitle={setNewTitle}
          newRequirement={newRequirement}
          setNewRequirement={setNewRequirement}
          newGitRepo={newGitRepo}
          setNewGitRepo={setNewGitRepo}
          newDeliveryPolicy={newDeliveryPolicy}
          setNewDeliveryPolicy={setNewDeliveryPolicy}
          creating={creating}
          discoveredProjects={discoveredProjects}
          projectsScanning={projectsScanning}
          projectsScanError={projectsScanError}
          loadDiscoveredProjects={loadDiscoveredProjects}
          setShowCreateForm={setShowCreateForm}
          handleCreateProject={handleCreateProject}
        />
      )}

      {showPublishDialog && (
        <PublishProjectDialog
          channels={channels}
          selectedChannelId={selectedChannelId}
          setSelectedChannelId={setSelectedChannelId}
          agentsLoading={agentsLoading}
          channelAgents={channelAgents}
          publishing={publishing}
          setShowPublishDialog={setShowPublishDialog}
          handlePublishConfirm={handlePublishConfirm}
        />
      )}
    </div>
  );
}

export default PMOPage;
