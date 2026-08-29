/**
 * Project 详情页 - GEN-005 + FL-013
 *
 * 显示项目详情、PMO 号、关联 OKR、进度管道、交付面板（DeliveryPanel）、项目进展、项目动态
 *
 * 合并功能：
 * - VS Code 打开 + Cloud IDE 弹窗（迁移自 ProjectDetail.tsx）
 * - 复制路径（迁移自 ProjectDetail.tsx）
 *
 * Card 7（2026-08）：老 Task 看板 / 执行历史 / 双轨统计已删除（WU 链路为唯一口径）；
 * 后端 /tasks API 与数据保留（存量 16 条 legacy task 仍可从 API 访问）。
 *
 * 工单 35-E4（2026-08-07）：IDE 指南弹窗（components/pmo/IdeGuideDialogs，服务器地址走
 * VITE_IDE_SSH_HOST / VITE_IDE_CLOUD_IDE_URL，原硬编码生产 IP 已消除）、
 * 项目进展卡（components/pmo/ProjectProgressCard）抽出。
 *
 * #149（2026-08-15）：document-store 退役——知识库文档区（KnowledgeDocGrid）、
 * 抽屉阅读器（DocReaderDrawer）、「归档知识」按钮、「模式识别」按钮（meso 端点）
 * 一并摘除。
 */

import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectApi, type DeliveryStatus } from '../api';
import { requirementApi, type RequirementChainWorkUnit } from '../api/requirements';
import { workunitApi } from '../api/workunit';
import { fanOut } from '../utils/fanOut';
import { maintenanceApi } from '../api/maintenance';
import { useRosterStore } from '../stores/rosterStore';
import { useAsyncData } from '../hooks/useAsyncData';
import { PmoNumberBadge } from '../components/PmoNumberBadge';
import { ProjectPipeline } from '../components/pmo/ProjectPipeline';
import { ProjectActivity } from '../components/pmo/ProjectActivity';
import { ProjectMap, NextActionCard } from '../components/pmo/ProjectMap';
import {
  pickNextAction,
  toNextActionCandidate,
  type NextActionCandidate,
  type PmoMap,
  type FogItem,
} from '../components/pmo/mapUtils';
import { DeliveryPanel } from '../components/pmo/DeliveryPanel';
import { VscodeGuideDialog, CloudIdeGuideDialog } from '../components/pmo/IdeGuideDialogs';
import { ProjectProgressCard } from '../components/pmo/ProjectProgressCard';
import { ManualTaskButton } from '../components/ui/ManualTaskButton';
import { BackButton } from '../components/ui';
import { buildProjectTimeline, type PipelineWorkUnit } from '../components/pmo/pipelineUtils';

interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description?: string;
  requirement?: string;
  status: string;
  priority: string;
  progress: number;
  gitBranch?: string;
  gitRepo?: string;
  // 🆕 PMO-a: REQ 只读别名 / 交付策略 / 杂务标记
  reqAlias?: string | null;
  deliveryPolicy?: string;
  isChore?: boolean;
  channelId?: string | null;
  worktreePath?: string;
  startedAt?: string;
  completedAt?: string;
  deliveredAt?: string | null;
  createdAt: string;
  /** #114 T8：探路地图（缺省 null = 非探路型，不渲染地图区） */
  map?: PmoMap | null;
  OKR?: { id: string; title: string; quarter: string };
}

// 🆕 AC-5: 项目状态 stepper（讨论 → 进行中 → 待验收 → 已交付；delivered 归并到 completed）
const PROJECT_STEPS = [
  { key: 'pending', label: '讨论' },
  { key: 'active', label: '进行中' },
  { key: 'in_review', label: '待验收' },
  { key: 'completed', label: '已交付' },
] as const;

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  // #350 useAsyncData 收一次性拉取样板：主拉取错误上屏（工单 38 口径）；projectId 切换渲染期重置。
  // 子拉取拆为并行 best-effort hook（原来在 loadData 内串行 await），失败静默落 null 不阻塞页面。
  const projectQ = useAsyncData<Project>(async () => {
    if (!projectId) throw new Error('Failed to load project');
    try {
      return (await projectApi.get(projectId)).data as Project;
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        .response?.data?.error?.message;
      throw new Error(msg || 'Failed to load project');
    }
  }, [projectId]);
  const project = projectQ.data;
  const loading = projectQ.loading;
  const error = projectQ.error;

  // 🆕 PMO-b: 交付台账（管道时间线 / 进展卡 / 证据警告条共用；交互在 DeliveryPanel，经 onRefresh 刷新）
  const deliveryQ = useAsyncData(async () => {
    if (!projectId) return null;
    try {
      return (await projectApi.getDelivery(projectId)).data as DeliveryStatus;
    } catch { return null; }
  }, [projectId]);
  const delivery = deliveryQ.data;

  // 🆕 AC-5: 进度管道（REQ chain WU + agent 名册）/ 原始需求折叠
  // #346：agent 名册读 rosterStore（TTL 缓存共享；非 Admin 403 时 agents 保持空列表，对齐旧 catch(() => null) 行为）
  const agents = useRosterStore((s) => s.agents);
  const chainQ = useAsyncData<RequirementChainWorkUnit[] | null>(async () => {
    if (!project?.reqAlias) return null;
    // #346：agent 名册走 rosterStore TTL 缓存（ensureFresh 永不 reject，错误落 store 状态）
    void useRosterStore.getState().ensureFresh();
    try {
      return (await requirementApi.getChain(project.reqAlias)).data?.data?.workunits ?? [];
    } catch { return []; }
  }, [project]);
  const chainWus = chainQ.data ?? [];
  const chainLoading = chainQ.loading;

  // 弹窗状态
  const [showVscodeGuide, setShowVscodeGuide] = useState(false);
  const [showCloudIdeGuide, setShowCloudIdeGuide] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [requirementExpanded, setRequirementExpanded] = useState(false);

  // 🆕 #114 T8：「下一个该干什么」——可认领 + 依赖已清的第一张
  //（列表 API claimable 标记 + metadata.pmoId 归属过滤，排序细则见 mapUtils.pickNextAction）
  const nextActionQ = useAsyncData(async () => {
    if (!project) return null;
    try {
      const unassignedRes = await workunitApi.list({ status: 'unassigned', limit: 100 });
      const candidates = (unassignedRes.data?.data ?? [])
        .map(w => toNextActionCandidate(w, project.id))
        .filter((c): c is NextActionCandidate => c !== null);
      const fogOrder = project.map?.fog.map(f => f.id) ?? [];
      return pickNextAction(candidates, fogOrder);
    } catch { return null; }
  }, [project]);
  const nextAction = nextActionQ.data;

  // 🆕 #114 T8：地图区决策单状态（fog.wuId 互挂的 decision WU 逐个 best-effort 拉；
  // 拉不到的徽章按待认领兜底，见 mapUtils.resolveFogBadge）
  const fogStatusQ = useAsyncData(async () => {
    if (!project?.map) return null;
    // 显式标注 FogItem[]：project 为无类型 axios 响应（any），经 fanOut 泛型边界会推成 unknown
    const fogEntries: FogItem[] = project.map.fog.filter(f => f.wuId);
    const results = await fanOut(fogEntries, f => workunitApi.get(f.wuId!));
    const statusMap: Record<string, string> = {};
    for (let i = 0; i < fogEntries.length; i++) {
      const r = results[i];
      if (r.ok && r.value.data?.status) statusMap[fogEntries[i].wuId!] = r.value.data.status;
    }
    return statusMap;
  }, [project]);
  const decisionStatusByWuId = fogStatusQ.data ?? {};

  // 🆕 F6-c: 重新拉台账 + 全量数据（缺口行动/交付成功后由 DeliveryPanel 回调）；
  // project 重拉落地后 chain/nextAction/fogStatus 依 [project] 身份自动级联重拉
  const refreshDelivery = () => {
    deliveryQ.reload();
    projectQ.reload();
  };

  // 复制路径
  const handleCopyPath = async () => {
    if (!project?.gitBranch) return;
    const path = project.worktreePath || `~/.studio/worktrees/${project.gitBranch}`;
    await navigator.clipboard.writeText(path);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  // 项目进展百分比（老 Task 链路已删除，统一取 project.progress）
  const progress = project?.progress || 0;

  // 🆕 AC-5: 管道 WU 直接用 chain 条目（§10：type/时间戳由 chain 自带）；项目动态由 WU 时间戳 + deliveredAt 拼装
  const pipelineWus: PipelineWorkUnit[] = chainWus;
  const agentNameById: Record<string, string> = {};
  for (const a of agents) agentNameById[a.id] = a.name;
  const timelineEntries = buildProjectTimeline(pipelineWus, {
    deliveredAt: delivery?.deliveredAt ?? project?.deliveredAt ?? null,
    agentNameById,
  });

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="u-text-2">加载中...</div></div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-64"><div className="u-err">{error}</div></div>;
  }

  if (!project) {
    return <div className="flex items-center justify-center h-64"><div className="u-text-2">项目不存在</div></div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        {/* #393 §4.4：详情页统一左上返回（直开回落 /pmo） */}
        <div className="mb-2"><BackButton fallback="/pmo" /></div>
        <div className="flex items-center gap-3 mb-2">
          <PmoNumberBadge pmoNumber={project.pmoNumber} status={project.status as 'pending' | 'active' | 'in_review' | 'completed' | 'cancelled'} size="lg" />
          <h1 className="page-title">{project.title}</h1>
        </div>
        <p className="u-text-2">{project.description || '无描述'}</p>
        {project.OKR && (
          <div className="text-sm u-text-2 mt-1">
            OKR: {project.OKR.title} ({project.OKR.quarter})
          </div>
        )}
        {/* 🆕 PMO-a: REQ 别名 / 分支 / 交付策略（有值才显示） */}
        {(project.reqAlias || project.gitBranch || project.deliveryPolicy) && (
          <div className="text-sm u-text-2 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {project.reqAlias && <span>REQ 别名: {project.reqAlias}</span>}
            {project.gitBranch && <span>分支: {project.gitBranch}</span>}
            {project.deliveryPolicy && (
              <span>
                交付策略: {project.deliveryPolicy === 'auto-merge' ? '自动合并' : '分支交付'}
              </span>
            )}
          </div>
        )}
        {/* 🆕 AC-5: 原始需求描述（可折叠，>120 字默认收起） */}
        {project.requirement && (
          <div className="mt-2 p-2 rounded u-surface-2">
            <div className="flex items-center justify-between">
              <span className="text-xs u-text-3">原始需求</span>
              {project.requirement.length > 120 && (
                <button
                  onClick={() => setRequirementExpanded(v => !v)}
                  className="text-xs u-accent"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {requirementExpanded ? '收起' : '展开'}
                </button>
              )}
            </div>
            <p className="text-sm u-text-2 mt-1 whitespace-pre-wrap">
              {requirementExpanded || project.requirement.length <= 120
                ? project.requirement
                : `${project.requirement.slice(0, 120)}…`}
            </p>
          </div>
        )}
        {/* 🆕 AC-5: 项目状态 stepper（当前阶段高亮）+ 去频道 */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {PROJECT_STEPS.map((s, i) => {
            const statusKey = project.status === 'delivered' ? 'completed' : project.status;
            const currentIdx = PROJECT_STEPS.findIndex(x => x.key === statusKey);
            return (
              <React.Fragment key={s.key}>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-medium ${
                    i === currentIdx ? 'u-accent-bg u-on-accent' :
                    currentIdx > i ? 'u-ok-dim u-ok' :
                    'u-surface-2 u-text-3'
                  }`}
                >
                  {s.label}
                </span>
                {i < PROJECT_STEPS.length - 1 && (
                  <span className={`text-xs ${currentIdx > i ? 'u-ok' : 'u-text-3'}`}>→</span>
                )}
              </React.Fragment>
            );
          })}
          {project.status === 'cancelled' && (
            <span className="text-xs px-2 py-1 rounded u-err-dim u-err">已取消</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {project.channelId && (
              <button
                onClick={() => navigate(`/channels/${project.channelId}`)}
                className="btn btn-sm u-accent-dim u-accent u-hover-bg"
              >
                💬 去频道
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 🆕 #114 T8：下一个该干什么（可认领 + 依赖已清的第一张；探路型 PMO 无可认领时也显示空态） */}
      {(nextAction || project.map) && <NextActionCard action={nextAction} />}

      {/* 🆕 AC-5: 进度管道（REQ 链路五泳道，WU 小卡可点 → /workunits/:id） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🚦 进度管道</h3>
        <ProjectPipeline workunits={pipelineWus} agents={agents} loading={chainLoading} />
      </div>

      {/* 🆕 #114 T8：地图区（目标 / 待决问题 / 结论时间线 / 任务单依赖；非探路型无 map 不渲染） */}
      {project.map && (
        <div className="card p-4 mb-6">
          <h3 className="text-sm font-medium u-text-2 mb-3">🗺️ 地图</h3>
          <ProjectMap map={project.map} decisionStatusByWuId={decisionStatusByWuId} chainWus={chainWus} />
        </div>
      )}

      {/* 🆕 PMO-b: 交付（台账 + human-only 合并 + F6-c 缺口行动）——Card 7 抽取为 DeliveryPanel */}
      {delivery && (
        <DeliveryPanel projectId={projectId!} delivery={delivery} onRefresh={refreshDelivery} />
      )}

      {/* 📈 项目进展（AS-010 增强） */}
      <ProjectProgressCard progress={progress} delivery={delivery} projectStatus={project.status} />

      {/* 🆕 AC-5: 项目动态（WU 时间戳 + deliveredAt 前端拼装，倒序 ≤20 条） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🕐 项目动态</h3>
        <ProjectActivity entries={timelineEntries} />
      </div>

      {/* 🛠️ 工具栏 */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setShowVscodeGuide(true)}
          className="btn btn-primary"
        >
          VS Code 打开
        </button>
        <button
          onClick={() => setShowCloudIdeGuide(true)}
          className="btn btn-primary"
        >
          ☁️ Cloud IDE
        </button>
        <button
          onClick={handleCopyPath}
          className="btn btn-secondary"
        >
          {copySuccess ? '✓ 已复制' : '📋 复制路径'}
        </button>
        {/* #163 T8-E2: 手动发起巡检（结果挂到巡检单详情页的机会清单，由人在那里确认） */}
        <ManualTaskButton
          label="🔍 发起巡检"
          onRun={async () => {
            await maintenanceApi.fireTrigger('inspection-scan');
            return '巡检单已创建，待人确认';
          }}
        />
      </div>

      {/* IDE 指南弹窗 */}
      <VscodeGuideDialog open={showVscodeGuide} onClose={() => setShowVscodeGuide(false)} />
      <CloudIdeGuideDialog open={showCloudIdeGuide} onClose={() => setShowCloudIdeGuide(false)} />
    </div>
  );
}

export default ProjectDetailPage;
