// PMOPage - PMO 管理主页面（项目 + OKR；三个弹窗已抽至 components/pmo/，工单 33）
// 2026-09-10 第二轮重设计：① 删「需求」tab（用户反馈看不懂且与 PMO 重复；REQ 主呈现位在频道右栏）；
// ② 项目列表 v2 = 紧凑行列表（pmo.css .pmo-row，细分隔线 + 状态色条，项目多了也可扫读）。
import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { projectApi } from '../api';
import { companyApi } from '../api/company';
import { okrApi, type OkrKeyResult } from '../api/pmo';
import { requirementApi } from '../api/requirements';
import { useAsyncData } from '../hooks/useAsyncData';
import { useRosterStore } from '../stores/rosterStore';
import '../styles/pmo.css';
import { CreateOkrDialog } from '../components/pmo/CreateOkrDialog';
import { CreateProjectDialog } from '../components/pmo/CreateProjectDialog';
import { PublishProjectDialog } from '../components/pmo/PublishProjectDialog';
import { ProjectCard } from '../components/pmo/ProjectCard';
import { SkeletonText } from '../components/ui';

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
        companyId: actualCompanyId,
        okrs: okrRes.data?.data || [],
        projects: (projectsRes.data?.data || []) as Project[],
      };
    } catch (err) {
      console.error('Failed to load PMO data:', err);
      throw new Error('加载 PMO 数据失败，请重试');
    }
  }, [companyId]);
  const reload = pmoQ.reload;

  // AC-6: Publish dialog 频道列表走 rosterStore channels 切片（#455：30s TTL + single-flight，
  // 新建频道经 appendChannel 写穿；失败时切片保持空/旧值，对齐原 best-effort 静默口径）
  const channels = useRosterStore((s) => s.channels);
  useEffect(() => { void useRosterStore.getState().ensureFresh(); }, []);

  // 🆕 AC-6: 卡片徽章数据（WU 完成度；#387 单请求批量、失败静默不显示）
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

  // 🆕 AC-6: 列表加载后单请求批量拉徽章数据（#387 chain-stats；finished 口径 workFinished
  // 服务端同源计算；失败静默不显示）
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
    if (withAlias.length === 0) {
      setWuStats({});
      return;
    }
    requirementApi.chainStats(withAlias.map(p => p.reqAlias)).then(res => {
      if (cancelled) return;
      // 服务端按 reqAlias 键返回，回填成 ProjectCard 消费的 project.id 键；缺 key（需求不存在）→ 不显示
      const stats = res.data?.data ?? {};
      const next: Record<string, { finished: number; total: number }> = {};
      for (const p of withAlias) {
        const s = stats[p.reqAlias];
        if (s) next[p.id] = s;
      }
      setWuStats(next);
    }).catch(() => { /* 失败静默：徽章不显示（卡片照常渲染） */ });

    return () => { cancelled = true; };
  }, [projects]);

  const handlePublishClick = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    setPublishProjectId(projectId);
    setShowPublishDialog(true);
  };

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">PMO 管理</h1>
            <p className="page-subtitle">项目组合 + OKR 管理</p>
          </div>
        </div>
      </div>

      {/* Tabs — E3（2026-09 页面重设计）：border-b 形态（批次 D-4 定 KnowledgePage 为正本）+ 去 emoji；
          2026-09-10 第二轮：删「需求」tab（与 PMO 重复，REQ 主呈现位在频道右栏）；
          批次 E-3：激活态底线收进 .u-tab/.u-tab-active 结构类（禁内联 borderBottom），transition 过渡走白名单①③ */}
      <div className="u-page-px pt-4">
        <div className="flex gap-1 mb-4 overflow-x-auto pb-1 border-b u-border">
          <button
            onClick={() => setActiveTab('projects')}
            className={`u-tab px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition ${activeTab === 'projects' ? 'u-tab-active u-surface u-accent' : 'u-text-3'}`}
          >
            项目 ({projects.length})
          </button>
          <button
            onClick={() => setActiveTab('okr')}
            className={`u-tab px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition ${activeTab === 'okr' ? 'u-tab-active u-surface u-accent' : 'u-text-3'}`}
          >
            OKR ({okrs.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto u-page-px pb-8">
        {/* 工单 38: 加载失败错误条（跟随 WorkUnitDetailPage 的 u-err-dim 错误条形态）+ 重试入口 */}
        {!loading && loadError && (
          <div className="mb-3 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
            <span>{loadError}</span>
            <button onClick={reload} className="btn btn-secondary btn-sm">重试</button>
          </div>
        )}
        {loading ? (
          /* 批次 E-2：静态骨架占位（贴近行列表形态，零动画） */
          <SkeletonText lines={5} className="space-y-3" />
        ) : activeTab === 'projects' ? (
          /* 2026-09 第二轮 v2：紧凑行列表（pmo.css .pmo-row，与 library/workunits 行模式同族） */
          <div>
            {/* 🆕 PMO-a: 新建 PMO 入口（表单为规范 modal，见页面底部） */}
            <button onClick={() => setShowCreateForm(true)} className="pmo-new">
              <span>+ 新建 PMO</span>
              <span className="text-xs u-text-3">直接下达项目指令，自动生成 PMO 号</span>
            </button>

            {projects.length === 0 ? (
              // 批次 D-3 项1：空态 = 说明 + 一个明确主行动（与上方虚线行同入 CreateProjectDialog）
              <div className="empty-state">
                <p>暂无项目</p>
                <p className="text-sm mt-2">下达项目指令即可创建，自动生成 PMO 编号</p>
                <button className="btn btn-primary mt-4" onClick={() => setShowCreateForm(true)}>新建 PMO</button>
              </div>
            ) : (
              <div className="pmo-list">
                {projects.map(project => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    wuStats={wuStats}
                    channels={channels}
                    handlePublishClick={handlePublishClick}
                  />
                ))}
              </div>
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
              /* 批次 E-2：空态 = 说明 + 一个明确主行动（批次 D-3 模式，入 CreateOkrDialog） */
              <div className="empty-state">
                <p>暂无 OKR</p>
                <p className="text-sm mt-2">为新季度设置目标和关键结果</p>
                <button className="btn btn-primary mt-4" onClick={() => setShowOKRDialog(true)}>创建 OKR</button>
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

      {/* 🆕 B8: 创建 OKR 弹窗 (支持 KR 编辑)；#434：路由不传 prop 时用查询解析出的 companyId */}
      <CreateOkrDialog
        open={showOKRDialog}
        companyId={companyId ?? pmoQ.data?.companyId}
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
