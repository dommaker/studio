// PMOPage - PMO 管理主页面（项目 + OKR；三个弹窗已抽至 components/pmo/，工单 33）
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { projectApi } from '../api';
import { companyApi } from '../api/company';
import { okrApi, type OkrKeyResult } from '../api/pmo';
import { channelApi, type Channel } from '../api/channel';
import { requirementApi } from '../api/requirements';
import { knowledgeApi } from '../api/knowledge';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { CreateOkrDialog } from '../components/pmo/CreateOkrDialog';
import { CreateProjectDialog } from '../components/pmo/CreateProjectDialog';
import { PublishProjectDialog } from '../components/pmo/PublishProjectDialog';

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
  keyResults?: OkrKeyResult[];
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
  // 工单 38: loadData 失败反馈（页面内错误条 + 重试，原先仅 console.error 静默）
  const [loadError, setLoadError] = useState<string | null>(null);

  // 🆕 AC-6: 卡片徽章数据（WU 完成度 / 文档计数；批量并行、失败静默不显示）
  const [wuStats, setWuStats] = useState<Record<string, { finished: number; total: number }>>({});
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});

  // 🆕 B8: OKR 创建弹窗（组件见 components/pmo/CreateOkrDialog）
  const [showOKRDialog, setShowOKRDialog] = useState(false);

  const tabParam = searchParams.get('tab');
  const defaultTab = tabParam === 'okr' ? 'okr' : 'projects';
  const [activeTab, setActiveTab] = useState<'projects' | 'okr'>(defaultTab);

  // AC-6: Publish dialog state（组件见 components/pmo/PublishProjectDialog）
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishProjectId, setPublishProjectId] = useState<string | null>(null);

  // 🆕 PMO-a: 新建 PMO 弹窗（组件见 components/pmo/CreateProjectDialog）
  const [showCreateForm, setShowCreateForm] = useState(false);

  // companyId 切换时在渲染期同步置回加载态并清错误（替代原 loadData 内、由 effect 触发的同步 setState）
  const [prevCompanyId, setPrevCompanyId] = useState(companyId);
  if (prevCompanyId !== companyId) {
    setPrevCompanyId(companyId);
    setLoading(true);
    setLoadError(null);
  }

  const loadData = useCallback(async () => {
    try {
      let actualCompanyId = companyId;
      if (!actualCompanyId) {
        const companiesRes = await companyApi.list();
        if (companiesRes.data?.data?.length > 0) {
          actualCompanyId = companiesRes.data.data[0].id;
        }
      }

      const [okrRes, projectsRes] = await Promise.all([
        actualCompanyId
          ? okrApi.list(actualCompanyId)
          : Promise.resolve({ data: { data: [] } }),
        actualCompanyId
          ? projectApi.list({ companyId: actualCompanyId, limit: 20 })
          : Promise.resolve({ data: { data: [] } }),
      ]);

      setOKRs(okrRes.data?.data || []);
      setProjects(projectsRes.data?.data || []);
    } catch (err) {
      console.error('Failed to load PMO data:', err);
      setLoadError('加载 PMO 数据失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  const loadChannels = useCallback(async () => {
    try {
      const res = await channelApi.list();
      setChannels(res.data?.data || []);
    } catch {
      // best-effort: channels may not be available
    }
  }, []);

  useEffect(() => {
    // 微任务里触发加载：loadData 为多 await async 函数，编译器对 effect 内同步调用保守告警
    void Promise.resolve().then(() => {
      loadData();
      loadChannels();
    });
  }, [loadData, loadChannels]);

  // 手动刷新路径（重试按钮 / 弹窗 onCreated）：在事件处理器里同步置加载态，保持原 loadData 行为
  const handleReload = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    loadData();
  }, [loadData]);

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

  const handlePublishClick = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    setPublishProjectId(projectId);
    setShowPublishDialog(true);
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
        {/* 工单 38: 加载失败错误条（跟随 WorkUnitDetailPage 的 u-err-dim 错误条形态）+ 重试入口 */}
        {!loading && loadError && (
          <div className="mb-3 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
            <span>{loadError}</span>
            <button onClick={handleReload} className="btn btn-secondary btn-sm">重试</button>
          </div>
        )}
        {loading ? (
          <div className="text-center py-8 u-text-3">
            加载中...
          </div>
        ) : activeTab === 'projects' ? (
          <div className="space-y-3">
            {/* 🆕 PMO-a: 新建 PMO 入口（表单为规范 modal，见页面底部） */}
            <button
              onClick={() => setShowCreateForm(true)}
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
                        <div className="text-lg font-bold u-ok">
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
                      {okr.keyResults.map((kr: OkrKeyResult) => (
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
      <CreateOkrDialog
        open={showOKRDialog}
        companyId={companyId}
        onClose={() => setShowOKRDialog(false)}
        onCreated={handleReload}
      />

      {/* 🆕 PMO-a: 新建 PMO 弹窗（style-guide §4.3 标准结构） */}
      <CreateProjectDialog
        open={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onCreated={handleReload}
      />

      {/* AC-6: 发起需求讨论弹窗（选择目标频道） */}
      <PublishProjectDialog
        open={showPublishDialog}
        projectId={publishProjectId}
        channels={channels}
        onClose={() => setShowPublishDialog(false)}
        onPublished={(channelId) => navigate(`/channels/${channelId}`)}
      />
    </div>
  );
}
