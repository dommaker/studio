// PMOPage - PMO 管理主页面（项目 + OKR；三个弹窗已抽至 components/pmo/，工单 33）
import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { projectApi } from '../api';
import { companyApi } from '../api/company';
import { okrApi, type OkrKeyResult } from '../api/pmo';
import { channelApi, type Channel } from '../api/channel';
import { requirementApi } from '../api/requirements';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { fanOut } from '../utils/fanOut';
import { useAsyncData } from '../hooks/useAsyncData';
import { CreateOkrDialog } from '../components/pmo/CreateOkrDialog';
import { CreateProjectDialog } from '../components/pmo/CreateProjectDialog';
import { PublishProjectDialog } from '../components/pmo/PublishProjectDialog';
import { ProjectCard } from '../components/pmo/ProjectCard';

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
  // #350 useAsyncData 收一次性拉取样板：companyId 切换渲染期重置 + loading/error 归一（工单 38 错误条口径保留）
  const pmoQ = useAsyncData(async () => {
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

      return {
        okrs: okrRes.data?.data || [],
        projects: (projectsRes.data?.data || []) as Project[],
      };
    } catch (err) {
      console.error('Failed to load PMO data:', err);
      throw new Error('加载 PMO 数据失败，请重试');
    }
  }, [companyId]);
  const reload = pmoQ.reload;

  // AC-6: Publish dialog 频道列表（best-effort，失败静默）
  const channelsQ = useAsyncData(() => channelApi.list().then(r => r.data?.data || []).catch(() => []), []);
  const channels: Channel[] = channelsQ.data ?? [];

  // 🆕 AC-6: 卡片徽章数据（WU 完成度；批量并行、失败静默不显示）
  // #149（2026-08-15）：文档计数徽章随 document-store 退役移除
  const [wuStats, setWuStats] = useState<Record<string, { finished: number; total: number }>>({});

  // 🆕 B8: OKR 创建弹窗（组件见 components/pmo/CreateOkrDialog）
  const [showOKRDialog, setShowOKRDialog] = useState(false);

  const tabParam = searchParams.get('tab');
  const defaultTab = tabParam === 'okr' ? 'okr' : 'projects';
  const [activeTab, setActiveTab] = useState<'projects' | 'okr'>(defaultTab);

  // AC-6: Publish dialog state（组件见 components/pmo/PublishProjectDialog）
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishProjectId, setPublishProjectId] = useState<string | null>(null);

  // 🆕 PMO-a: 新建 PMO 弹窗（组件见 components/pmo/CreateProjectDialog）
  const [showCreateForm, setShowCreateForm] = useState(false);

  const loading = pmoQ.loading;
  const loadError = pmoQ.error;
  // 派生数组 useMemo 稳身份：wuStats effect 依赖 projects，避免 data 未落地时逐帧换引用
  const okrs = useMemo(() => pmoQ.data?.okrs ?? [], [pmoQ.data]);
  const projects = useMemo(() => pmoQ.data?.projects ?? [], [pmoQ.data]);

  // 🆕 AC-6: 列表加载后对可见项目批量并行查徽章数据（每项目一次 chain；失败静默）
  // projects 变空时在渲染期同步清空徽章（派生重置，替代原 effect 顶部的同步清空）
  const projectsEmpty = projects.length === 0;
  const [prevProjectsEmpty, setPrevProjectsEmpty] = useState(projectsEmpty);
  if (prevProjectsEmpty !== projectsEmpty) {
    setPrevProjectsEmpty(projectsEmpty);
    if (projectsEmpty) {
      setWuStats({});
    }
  }

  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    let cancelled = false;

    const withAlias = projects.filter((p): p is Project & { reqAlias: string } => !!p.reqAlias);
    fanOut(withAlias, async p => {
      const res = await requirementApi.getChain(p.reqAlias);
      const wus = res.data?.data?.workunits ?? [];
      // 完成口径 = workFinished 所有权口径（F6 铁律）
      const finished = wus.filter(w =>
        deriveDisplayState({ status: w.status, metadata: w.metadata }).workFinished).length;
      return { id: p.id, finished, total: wus.length };
    }).then(results => {
      if (cancelled) return;
      const next: Record<string, { finished: number; total: number }> = {};
      for (const r of results) {
        if (r.ok) next[r.value.id] = { finished: r.value.finished, total: r.value.total };
      }
      setWuStats(next);
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
            <button onClick={reload} className="btn btn-secondary btn-sm">重试</button>
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
                <ProjectCard
                  key={project.id}
                  project={project}
                  wuStats={wuStats}
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
                        <div style={{ fontSize: 'var(--fs-stat)' }} className="font-mono font-bold u-ok">
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
        onCreated={reload}
      />

      {/* 🆕 PMO-a: 新建 PMO 弹窗（style-guide §4.3 标准结构） */}
      <CreateProjectDialog
        open={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onCreated={reload}
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
