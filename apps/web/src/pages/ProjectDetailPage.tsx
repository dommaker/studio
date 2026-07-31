/**
 * Project 详情页 - GEN-005 + FL-013
 * 
 * 显示项目详情、PMO 号、关联 OKR、任务看板、项目进展、Token 消耗、会议历史、执行历史
 * 
 * 合并功能：
 * - VS Code 打开 + Cloud IDE 弹窗（迁移自 ProjectDetail.tsx）
 * - 归档知识库 + 复制路径（迁移自 ProjectDetail.tsx）
 * - 任务看板 + 项目进展统计（新增）
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectApi, api, type DeliveryStatus, type DeliveryGap } from '../api';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { requirementApi, type RequirementChainWorkUnit } from '../api/requirements';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { knowledgeApi, type KnowledgeDoc } from '../api/knowledge';
import { PmoNumberBadge } from '../components/PmoNumberBadge';
import { Timeline } from '../components/Timeline';
import { IronLawWarningBanner } from '../components/IronLawWarningBanner';
import { ProjectPipeline } from '../components/pmo/ProjectPipeline';
import { ProjectActivity } from '../components/pmo/ProjectActivity';
import { buildProjectTimeline, type PipelineWorkUnit } from '../components/pmo/pipelineUtils';
import { DocReaderDrawer } from '../components/knowledge/DocReaderDrawer';
import { toast } from '../utils/toast';
import type { StatsPhase, NodeExecution } from '../types';

interface Task {
  id: string;
  name: string;
  description?: string;
  assignee: string;
  priority: string;
  status: string;
  claimedBy?: string;
  claimedAt?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  estimatedHours?: number;
  createdAt: string;
  ClaimedBy?: { id: string; name: string; type: string };
}

interface Execution {
  id: string;
  status: string;
  workflowName?: string;
  parameters?: any;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  steps?: StatsPhase[];
  currentStep?: number;
  totalSteps?: number;
  nodeExecutions?: NodeExecution[];
}

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
  OKR?: { id: string; title: string; quarter: string };
  Execution?: Execution[];
}

// VS Code 连接步骤
const vscodeSteps = [
  { step: 1, text: '安装 VS Code + Remote SSH 扩展' },
  { step: 2, text: '打开 VS Code，按 F1 输入 "Remote-SSH: Connect to Host"' },
  { step: 3, text: '输入服务器地址：root@49.232.195.87' },
  { step: 4, text: '连接成功后，File → Open Folder → 粘贴项目路径' },
];

// Cloud IDE 步骤
const cloudIdeSteps = [
  { step: 1, text: '访问 Cloud IDE：http://49.232.195.87:8443' },
  { step: 2, text: '登录密码：从管理员获取' },
  { step: 3, text: 'File → Open Folder → 粘贴项目路径' },
];

// 🆕 F6-c: 缺口层 → 人话文案
const GAP_LAYER_LABELS: Record<'l1' | 'l2' | 'l3', string> = {
  l1: '缺 L1 自动验证',
  l2: '缺 L2 agent 评审',
  l3: '缺 L3 人工确认',
};

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
  
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([]);  // 知识库文档
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 🆕 AC-5: 进度管道（REQ chain WU + 详情补全 + agent 名册）/ 文档阅读器 / 原始需求折叠
  const [chainWus, setChainWus] = useState<RequirementChainWorkUnit[]>([]);
  const [wuDetails, setWuDetails] = useState<Record<string, WorkUnit>>({});
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [chainLoading, setChainLoading] = useState(false);
  const [readerDocId, setReaderDocId] = useState<string | null>(null);
  const [requirementExpanded, setRequirementExpanded] = useState(false);
  
  // 弹窗状态
  const [showVscodeGuide, setShowVscodeGuide] = useState(false);
  const [showCloudIdeGuide, setShowCloudIdeGuide] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [copiedStep, setCopiedStep] = useState<number | null>(null);

  // 🆕 PMO-b: 交付台账 + 交付合并（决策 1：合并动作为 human-only 手动触发）
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [deliverError, setDeliverError] = useState<{ message: string; missing?: string[]; conflictFiles?: string[] } | null>(null);
  // 🆕 F6-c: 缺口行动按钮的独立 loading 态（key = `${wuId}:${action}`），防重复点击
  const [gapActionPending, setGapActionPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!projectId) return;
    loadData();
  }, [projectId]);

  const loadData = async () => {
    try {
      setLoading(true);

      // 加载项目详情（必须成功）
      const projectRes = await projectApi.get(projectId!);
      const projectData = projectRes.data;
      setProject(projectData);
      setLoading(false);

      // 加载任务列表（best-effort，不阻塞页面）
      try {
        const tasksRes = await api.get(`/tasks?projectId=${projectId}`);
        setTasks(tasksRes.data || []);
      } catch { setTasks([]); }

      // 加载知识库文档（best-effort，不阻塞页面）
      try {
        const docsRes = await knowledgeApi.listByProject(projectId!);
        setDocuments(docsRes.data?.documents || []);
      } catch { setDocuments([]); }

      // 🆕 PMO-b: 加载交付台账（best-effort，不阻塞页面）
      try {
        const deliveryRes = await projectApi.getDelivery(projectId!);
        setDelivery(deliveryRes.data);
      } catch { setDelivery(null); }

      // 🆕 AC-5: 进度管道数据（best-effort）——REQ 链路 WU + 详情补全（type/时间戳，chain 不含）+ agent 名册
      if (projectData.reqAlias) {
        setChainLoading(true);
        try {
          const chainRes = await requirementApi.getChain(projectData.reqAlias);
          const wus = chainRes.data?.data?.workunits ?? [];
          setChainWus(wus);
          const [detailResults, agentsRes] = await Promise.all([
            Promise.allSettled(wus.map(wu => workunitApi.get(wu.id))),
            monitoringApi.getAgentSummary().catch(() => null),
          ]);
          const details: Record<string, WorkUnit> = {};
          detailResults.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value?.data) details[wus[i].id] = r.value.data;
          });
          setWuDetails(details);
          setAgents(agentsRes?.data?.agents ?? []);
        } catch {
          setChainWus([]);
          setWuDetails({});
        } finally {
          setChainLoading(false);
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to load project');
      setLoading(false);
    }
  };

  // 复制步骤
  const copyStep = async (text: string, stepIndex: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedStep(stepIndex);
    setTimeout(() => setCopiedStep(null), 2000);
  };

  // 复制路径
  const handleCopyPath = async () => {
    if (!project?.gitBranch) return;
    const path = project.worktreePath || `~/.studio/worktrees/${project.gitBranch}`;
    await navigator.clipboard.writeText(path);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  // 归档知识库：把项目文档中未归档的全部置 archived（human-only）
  const archivableDocs = documents.filter(d => d.status !== 'archived');

  const handleArchive = async () => {
    if (!projectId || archivableDocs.length === 0) return;

    try {
      setArchiveLoading(true);
      const results = await Promise.allSettled(
        archivableDocs.map(doc => api.post(`/knowledge/${doc.id}/archive`)),
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const succeeded = results.length - failed;
      if (failed === 0) {
        toast.success(`已归档 ${succeeded} 篇文档`);
      } else {
        toast.error(`归档失败 ${failed} 篇（成功 ${succeeded} 篇）`);
      }
      // 刷新文档列表
      try {
        const docsRes = await knowledgeApi.listByProject(projectId);
        setDocuments(docsRes.data?.documents || []);
      } catch { /* best-effort */ }
    } finally {
      setArchiveLoading(false);
    }
  };

  // 🆕 F6-c: 重新拉台账 + 全量数据（缺口行动成功后刷新）
  const refreshDelivery = async () => {
    if (!projectId) return;
    try {
      const deliveryRes = await projectApi.getDelivery(projectId);
      setDelivery(deliveryRes.data);
    } catch { /* best-effort */ }
    loadData();
  };

  // 🆕 F6-c: 缺口行动——重跑 L1 验证 / 补派 L2 评审 / L3 人工确认
  const handleGapAction = async (gap: DeliveryGap, action: 'verify' | 'dispatchReview' | 'reviewPassed') => {
    const key = `${gap.id}:${action}`;
    setGapActionPending(prev => ({ ...prev, [key]: true }));
    try {
      if (action === 'verify') {
        const res = await workunitApi.verify(gap.id);
        if (res.data?.verified) {
          toast.success('验证通过，L1 已补齐');
          await refreshDelivery();
        } else {
          const failedCmds = (res.data?.failed || []).map(f => f.command).join('；');
          toast.error(`验证未通过${failedCmds ? `：${failedCmds}` : ''}`);
        }
      } else if (action === 'dispatchReview') {
        await workunitApi.dispatchReview(gap.id);
        toast.success('已创建评审 WorkUnit，待 agent 认领');
        await refreshDelivery();
      } else {
        await workunitApi.reviewPassed(gap.id);
        toast.success('已确认，L3 已补齐');
        await refreshDelivery();
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const errData = err?.response?.data?.error;
      if (action === 'verify' && status === 422) {
        toast.error(err?.response?.data?.hint || '未配置验证命令（verifyCommands）');
      } else if (action === 'verify' && status === 409) {
        toast.error(errData?.message || '无 worktree，无法重跑验证');
      } else if (action === 'dispatchReview' && status === 409) {
        toast.info('评审已在途或已完成');
      } else {
        toast.error(errData?.message || err?.message || '操作失败');
      }
    } finally {
      setGapActionPending(prev => ({ ...prev, [key]: false }));
    }
  };

  // 🆕 PMO-b: 交付合并（409 时展示缺口/冲突清单）
  const handleDeliver = async () => {
    if (!projectId) return;
    setDelivering(true);
    setDeliverError(null);
    try {
      const res = await projectApi.deliver(projectId);
      toast.success(`交付成功${res.data?.deliverCommit ? ` (${String(res.data.deliverCommit).slice(0, 7)})` : ''}`);
      // 刷新台账与项目信息（显示 deliveredAt/deliveredBy/deliverCommit）
      try {
        const deliveryRes = await projectApi.getDelivery(projectId);
        setDelivery(deliveryRes.data);
      } catch { /* best-effort */ }
      loadData();
    } catch (err: any) {
      const errData = err?.response?.data?.error;
      if (err?.response?.status === 409 && errData) {
        setDeliverError({
          message: errData.message || '交付被拒绝',
          missing: errData.missing,
          conflictFiles: errData.conflictFiles,
        });
      } else {
        toast.error(errData?.message || err?.message || '交付失败');
      }
    } finally {
      setDelivering(false);
    }
  };

  // 计算项目进展
  const getProgressStats = () => {
    const completed = tasks.filter(t => t.status === 'completed').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress' || t.status === 'claimed').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const total = tasks.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : (project?.progress || 0);
    return { completed, inProgress, pending, blocked, total, progress };
  };

  // 计算 Token 消耗（delivery 存在时优先用 WU 链路台账口径；否则回退老 Execution 累加）
  const getTokenStats = () => {
    if (delivery) return delivery.tokens;
    const executions = project?.Execution || [];
    const totalTokens = executions.reduce((sum, exec) => {
      const params = exec.parameters as any;
      return sum + (params?.tokenUsage?.total || 0);
    }, 0);
    return totalTokens;
  };

  // 按状态分组任务
  const getTasksByStatus = () => {
    return {
      pending: tasks.filter(t => t.status === 'pending'),
      inProgress: tasks.filter(t => t.status === 'in_progress' || t.status === 'claimed'),
      completed: tasks.filter(t => t.status === 'completed'),
      blocked: tasks.filter(t => t.status === 'blocked'),
    };
  };

  const progressStats = getProgressStats();
  const tokenStats = getTokenStats();
  const tasksByStatus = getTasksByStatus();

  // 🆕 AC-5: 管道 WU = chain 条目 + 详情补全（type/时间戳）；项目动态由 WU 时间戳 + deliveredAt 拼装
  const pipelineWus: PipelineWorkUnit[] = chainWus.map(wu => {
    const d = wuDetails[wu.id];
    return {
      ...wu,
      type: d?.type,
      createdAt: d?.createdAt ?? null,
      claimedAt: d?.claimedAt ?? null,
      completedAt: d?.completedAt ?? null,
    };
  });
  const agentNameById: Record<string, string> = {};
  for (const a of agents) agentNameById[a.id] = a.name;
  const timelineEntries = buildProjectTimeline(pipelineWus, {
    deliveredAt: delivery?.deliveredAt ?? project?.deliveredAt ?? null,
    agentNameById,
  });

  // 证据缺口摘要（L1/L2/L3 缺的层为 0 不显示），用于进展卡的琥珀警告条
  const evidenceGapSummary = delivery
    ? [
        { label: 'L1', n: delivery.evidence.l1Missing.length },
        { label: 'L2', n: delivery.evidence.l2Missing.length },
        { label: 'L3', n: delivery.evidence.l3Missing.length },
      ]
        .filter(g => g.n > 0)
        .map(g => `${g.label} 缺 ${g.n}`)
        .join(' · ')
    : '';

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
        <button
          onClick={() => navigate('/pmo')}
          className="text-sm mb-2"
          style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          ← 返回
        </button>
        <div className="flex items-center gap-3 mb-2">
          <PmoNumberBadge pmoNumber={project.pmoNumber} status={project.status as any} size="lg" />
          <h1 className="text-2xl font-bold">{project.title}</h1>
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
          {project.channelId && (
            <button
              onClick={() => navigate(`/channels/${project.channelId}`)}
              className="ml-auto px-3 py-1.5 rounded text-xs u-accent-dim u-accent u-hover-bg"
            >
              💬 去频道
            </button>
          )}
        </div>
      </div>

      {/* 🆕 AC-5: 进度管道（REQ 链路五泳道，WU 小卡可点 → /workunits/:id） */}
      <div className="u-surface rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🚦 进度管道</h3>
        <ProjectPipeline workunits={pipelineWus} agents={agents} loading={chainLoading} />
      </div>

      {/* 📚 知识库（AC-5：卡片点开抽屉阅读器） */}
      <div className="u-surface rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">📚 知识库 ({documents.length})</h3>
        {documents.length === 0 ? (
          <div className="text-sm u-text-3">暂无文档产出</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {/* requirement */}
            <div className="p-3 rounded-lg u-warn-dim">
              <div className="text-xs u-warn mb-2">📄 需求文档</div>
              <div className="space-y-1">
                {documents.filter(d => d.type === 'requirement').map(doc => (
                  <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs u-text-3">v{doc.version}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* design/spec */}
            <div className="p-3 rounded-lg u-accent-dim">
              <div className="text-xs u-accent mb-2">📐 设计/规范</div>
              <div className="space-y-1">
                {documents.filter(d => d.type === 'design' || d.type === 'spec').map(doc => (
                  <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs u-text-3">{doc.type} v{doc.version}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* execution/archive */}
            <div className="p-3 rounded-lg u-accent-dim">
              <div className="text-xs u-accent mb-2">📦 执行/归档</div>
              <div className="space-y-1">
                {documents.filter(d => ['execution', 'archive'].includes(d.type)).map(doc => (
                  <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs u-text-3">{doc.type}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 🆕 PMO-b: 交付（台账 + human-only 合并 + F6-c 缺口行动） */}
      {delivery && (
        <div className="u-surface rounded-lg shadow p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium u-text-2">📦 交付</h3>
            {delivery.deliveredAt ? (
              <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium">✓ 已交付</span>
            ) : delivery.deliverable ? (
              <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium">✓ 可交付</span>
            ) : delivery.wu.inFlight > 0 ? (
              <span className="text-xs px-2 py-1 rounded u-accent-dim u-accent font-medium">
                🔄 进行中 {delivery.wu.finished}/{delivery.wu.total}
              </span>
            ) : (
              <span className="text-xs px-2 py-1 rounded u-warn-dim u-warn font-medium">
                ⏳ 待验收:证据还差 {delivery.evidence.l1Missing.length + delivery.evidence.l2Missing.length + delivery.evidence.l3Missing.length} 项
              </span>
            )}
          </div>

          {/* 台账概览：策略 / 分支 / WU 完成度 / 证据三层 / 自评 */}
          <div className="text-sm u-text-2 flex flex-wrap gap-x-4 gap-y-1 mb-2">
            <span>交付策略: {delivery.policy === 'auto-merge' ? '自动合并' : '分支交付'}</span>
            <span>分支: {delivery.branch || '—'}</span>
            <span>WU: {delivery.wu.finished}/{delivery.wu.total} 完成</span>
            <span>L1: {delivery.evidence.l1Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l1Missing.length}`}</span>
            <span>L2: {delivery.evidence.l2Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l2Missing.length}`}</span>
            <span>L3: {delivery.evidence.l3Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l3Missing.length}`}</span>
            <span>自评: {delivery.evidence.selfReviewCount}</span>
          </div>

          {/* 无 WU 时的非缺口提示 */}
          {delivery.wu.total === 0 && (
            <div className="text-xs u-text-3 mb-2">无关联 WorkUnit</div>
          )}

          {/* 🆕 F6-c: 缺口行动清单（已完成但证据有缺口的 WU，逐行给补齐动作） */}
          {!delivery.deliverable && delivery.gaps.length > 0 && (
            <div className="mb-2">
              {delivery.wu.inFlight > 0 && (
                <div className="text-xs u-text-3 mb-1">{delivery.wu.inFlight} 个 WorkUnit 仍在途</div>
              )}
              <div className="space-y-1">
                {delivery.gaps.map(gap => (
                  <div key={gap.id} className="flex items-center justify-between gap-2 text-xs u-surface-2 rounded px-2 py-1.5">
                    <div className="min-w-0">
                      <span className="u-text font-medium">{gap.title}</span>
                      <span className="u-text-3 ml-1">{gap.type}</span>
                      <div className="u-warn">
                        {gap.missing.map(layer => GAP_LAYER_LABELS[layer]).join(' · ')}
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {/* AC-5: gap.id 即 WU id，直跳 WU 详情 */}
                      <button
                        onClick={() => navigate(`/workunits/${gap.id}`)}
                        className="px-2 py-1 rounded u-surface-2 u-text-2 u-hover-bg"
                      >
                        查看 WU ›
                      </button>
                      {gap.missing.includes('l1') && (
                        <button
                          onClick={() => handleGapAction(gap, 'verify')}
                          disabled={!!gapActionPending[`${gap.id}:verify`]}
                          className="px-2 py-1 rounded u-accent-dim u-accent u-hover-bg disabled:opacity-50"
                        >
                          {gapActionPending[`${gap.id}:verify`] ? '验证中...' : '重跑验证'}
                        </button>
                      )}
                      {gap.missing.includes('l2') && (
                        <button
                          onClick={() => handleGapAction(gap, 'dispatchReview')}
                          disabled={!!gapActionPending[`${gap.id}:dispatchReview`]}
                          className="px-2 py-1 rounded u-accent-dim u-accent u-hover-bg disabled:opacity-50"
                        >
                          {gapActionPending[`${gap.id}:dispatchReview`] ? '派发中...' : '派发评审'}
                        </button>
                      )}
                      {gap.missing.includes('l3') && (
                        <button
                          onClick={() => handleGapAction(gap, 'reviewPassed')}
                          disabled={!!gapActionPending[`${gap.id}:reviewPassed`]}
                          className="px-2 py-1 rounded u-ok-dim u-ok u-hover-bg disabled:opacity-50"
                        >
                          {gapActionPending[`${gap.id}:reviewPassed`] ? '确认中...' : '人工确认'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 已交付记录（时间 / 人 / commit 短哈希） */}
          {delivery.deliveredAt && (
            <div className="text-xs u-ok u-ok-dim rounded p-2 mb-2">
              已交付: {new Date(delivery.deliveredAt).toLocaleString('zh-CN')}
              {delivery.deliveredBy && ` · ${delivery.deliveredBy}`}
              {delivery.deliverCommit && ` · ${delivery.deliverCommit.slice(0, 7)}`}
            </div>
          )}

          {/* 交付动作：auto-merge 给按钮；branch-only 给说明 */}
          {delivery.policy === 'auto-merge' ? (
            <div>
              <button
                onClick={handleDeliver}
                disabled={delivering || !!delivery.deliveredAt}
                className="px-4 py-2 u-ok-bg u-on-accent rounded u-hover-bg disabled:opacity-50"
              >
                {delivering ? '交付中...' : delivery.deliveredAt ? '已交付' : '交付合并'}
              </button>
              {/* 409：缺口 / 冲突文件清单 */}
              {deliverError && (
                <div className="mt-2 text-xs u-err u-err-dim rounded p-2">
                  <div className="font-medium mb-1">{deliverError.message}</div>
                  {deliverError.missing && deliverError.missing.length > 0 && (
                    <ul className="list-disc pl-5 space-y-0.5">
                      {deliverError.missing.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  )}
                  {deliverError.conflictFiles && deliverError.conflictFiles.length > 0 && (
                    <div className="mt-1">
                      冲突文件: {deliverError.conflictFiles.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            // branch-only：证据齐且未交付才提示手动合并；证据未齐时缺口行动清单就是指引
            delivery.deliverable && !delivery.deliveredAt && (
              <div className="text-xs u-text-3">
                证据已齐:请合并分支 {delivery.branch} 并走下游发布链路
              </div>
            )
          )}
        </div>
      )}

      {/* 📈 项目进展（AS-010 增强） */}
      <div className="u-surface rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">📈 项目进展</h3>
        
        {/* 主进度条 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1">
            <div className="h-4 u-surface-2 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${
                  progressStats.progress === 100 ? 'u-ok-bg' :
                  progressStats.progress > 50 ? 'bg-gradient-to-r from-blue-400 to-blue-600' :
                  'bg-gradient-to-r from-yellow-400 to-yellow-500'
                }`}
                style={{ width: `${progressStats.progress}%` }}
              />
            </div>
          </div>
          <span className="text-2xl font-bold u-text">{progressStats.progress}%</span>
        </div>
        
        {/* 统计卡片：老 Task 链路五卡 / WU 链路六卡（tasks 为空且有台账时） */}
        {tasks.length === 0 && delivery ? (
          <div className="grid grid-cols-6 gap-2">
            <div className="p-2 rounded-lg u-ok-dim text-center">
              <div className="text-lg font-bold u-ok">{delivery.wu.finished}</div>
              <div className="text-xs u-text-2">✅ 完成</div>
            </div>
            <div className="p-2 rounded-lg u-warn-dim text-center">
              <div className="text-lg font-bold u-warn">{delivery.wu.byStatus.inReview}</div>
              <div className="text-xs u-text-2">👀 待验收</div>
            </div>
            <div className="p-2 rounded-lg u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{delivery.wu.byStatus.active}</div>
              <div className="text-xs u-text-2">🔄 进行中</div>
            </div>
            <div className="p-2 rounded-lg u-surface-2 text-center">
              <div className="text-lg font-bold u-text-2">{delivery.wu.byStatus.unassigned}</div>
              <div className="text-xs u-text-2">⏳ 待领取</div>
            </div>
            <div className="p-2 rounded-lg u-err-dim text-center">
              <div className="text-lg font-bold u-err">{delivery.wu.byStatus.blocked}</div>
              <div className="text-xs u-text-2">🚫 阻塞</div>
            </div>
            <div className="p-2 rounded-lg u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{delivery.tokens.toLocaleString()}</div>
              <div className="text-xs u-text-2">💰 Token</div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            <div className="p-2 rounded-lg u-ok-dim text-center">
              <div className="text-lg font-bold u-ok">{progressStats.completed}</div>
              <div className="text-xs u-text-2">✅ 完成</div>
            </div>
            <div className="p-2 rounded-lg u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{progressStats.inProgress}</div>
              <div className="text-xs u-text-2">🔄 进行中</div>
            </div>
            <div className="p-2 rounded-lg u-surface-2 text-center">
              <div className="text-lg font-bold u-text-2">{progressStats.pending}</div>
              <div className="text-xs u-text-2">⏳ 待领取</div>
            </div>
            <div className="p-2 rounded-lg u-err-dim text-center">
              <div className="text-lg font-bold u-err">{progressStats.blocked}</div>
              <div className="text-xs u-text-2">🚫 阻塞</div>
            </div>
            <div className="p-2 rounded-lg u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{tokenStats.toLocaleString()}</div>
              <div className="text-xs u-text-2">💰 Token</div>
            </div>
          </div>
        )}
        
        {/* 时间线进度（可视化状态转换） */}
        <div className="mt-4 flex items-center gap-2">
          {['pending', 'active', 'in_review', 'completed'].map((s, i) => {
            const isActive = project.status === s;
            const isPast = ['pending', 'active', 'in_review', 'completed'].indexOf(s) < 
                           ['pending', 'active', 'in_review', 'completed'].indexOf(project.status);
            const labels: Record<string, string> = {
              pending: '⏸️ 待启动',
              active: '🔄 进行中',
              in_review: '👀 审核中',
              completed: '✅ 已完成'
            };
            
            return (
              <React.Fragment key={s}>
                <div className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  isActive ? 'u-accent-bg u-on-accent' :
                  isPast ? 'u-ok-dim u-ok' :
                  'u-surface-2 u-text-3'
                }`}>
                  {labels[s]}
                </div>
                {i < 3 && (
                  <div className={`text-lg ${isPast || isActive ? 'u-ok' : 'u-text-3'}`}>→</div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* 证据提示条：存量 completed 缺证据给警告；in_review 说明自动翻转 */}
        {project.status === 'completed' && delivery && !delivery.deliverable && evidenceGapSummary && (
          <div className="mt-3 text-xs u-warn u-warn-dim rounded p-2">
            ⚠️ 项目已标记完成，但交付证据未齐（{evidenceGapSummary}）——在上方交付卡补齐后才算真正交付
          </div>
        )}
        {project.status === 'in_review' && delivery && !delivery.deliverable && (
          <div className="mt-3 text-xs u-accent u-accent-dim rounded p-2">
            交付证据补齐后，项目将自动标记完成
          </div>
        )}
      </div>

      {/* 📋 任务看板 */}
      {tasks.length > 0 && (
        <div className="u-surface rounded-lg shadow p-4 mb-6">
          <h3 className="text-sm font-medium u-text-2 mb-3">📋 任务看板 ({tasks.length})</h3>
          
          {/* 🆕 AS-018: Iron Law 警告横幅 */}
          {(tasksByStatus.inProgress.length > 0 || tasksByStatus.completed.length > 0) && (
            <IronLawWarningBanner
              scenario="task_complete"
              hasTestEvidence={false}
              hasVerification={false}
              hasRequirementReview={false}
            />
          )}
          
          <div className="grid grid-cols-4 gap-2">
            {/* 待领取 */}
            <div className="p-3 rounded-lg u-surface-2">
              <div className="text-xs u-text-2 mb-2">待领取 ({tasksByStatus.pending.length})</div>
              <div className="space-y-2">
                {tasksByStatus.pending.map(task => (
                  <div key={task.id} className="p-2 u-surface rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs u-text-3">{task.assignee}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 进行中 */}
            <div className="p-3 rounded-lg u-accent-dim">
              <div className="text-xs u-accent mb-2">进行中 ({tasksByStatus.inProgress.length})</div>
              <div className="space-y-2">
                {tasksByStatus.inProgress.map(task => (
                  <div key={task.id} className="p-2 u-surface rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs u-text-3">{task.ClaimedBy?.name || task.assignee}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 已完成 */}
            <div className="p-3 rounded-lg u-ok-dim">
              <div className="text-xs u-ok mb-2">已完成 ({tasksByStatus.completed.length})</div>
              <div className="space-y-2">
                {tasksByStatus.completed.map(task => (
                  <div key={task.id} className="p-2 u-surface rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs u-text-3">✅</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 阻塞 */}
            <div className="p-3 rounded-lg u-err-dim">
              <div className="text-xs u-err mb-2">阻塞 ({tasksByStatus.blocked.length})</div>
              <div className="space-y-2">
                {tasksByStatus.blocked.map(task => (
                  <div key={task.id} className="p-2 u-surface rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs u-err">依赖: {task.dependsOn.length}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 📦 执行历史（AS-010 增强） */}
      {project.Execution && project.Execution.length > 0 && (
        <div className="u-surface rounded-lg shadow p-4 mb-6">
          <h3 className="text-sm font-medium u-text-2 mb-3">📦 执行历史 ({project.Execution.length})</h3>
          <div className="space-y-3">
            {project.Execution.slice(0, 5).map(exec => {
              // 解析 steps 数据
              const steps = exec.steps ? (Array.isArray(exec.steps) ? exec.steps : Object.values(exec.steps)) : [];
              const currentStep = exec.currentStep || 0;
              const totalSteps = exec.totalSteps || steps.length || 1;
              const progressPercent = Math.round((currentStep / totalSteps) * 100);
              
              return (
                <div key={exec.id} className="p-3 u-surface-2 rounded border u-border">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="u-text text-sm font-mono">{exec.id.slice(0, 8)}</span>
                      {exec.workflowName && (
                        <span className="text-xs u-text-3">{exec.workflowName}</span>
                      )}
                    </div>
                    <span className={`text-xs px-2 py-1 rounded ${
                      exec.status === 'completed' || exec.status === 'succeeded' ? 'u-ok-dim u-ok' :
                      exec.status === 'running' ? 'u-accent-dim u-accent' :
                      exec.status === 'failed' ? 'u-err-dim u-err' :
                      'u-surface-2 u-text-2'
                    }`}>
                      {exec.status === 'succeeded' ? '✅ 成功' :
                       exec.status === 'running' ? '⏳ 运行中' :
                       exec.status === 'failed' ? '❌ 失败' :
                       exec.status === 'completed' ? '✅ 完成' : exec.status}
                    </span>
                  </div>
                  
                  {/* 进度条 */}
                  {(exec.status === 'running' || steps.length > 0) && (
                    <div className="mb-2">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="flex-1 u-surface-2 rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full transition-all ${
                              exec.status === 'running' ? 'bg-gradient-to-r from-blue-400 to-blue-600' :
                              exec.status === 'failed' ? 'u-err-bg' : 'u-ok-bg'
                            }`}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <span className="text-xs u-text-2">{progressPercent}%</span>
                      </div>
                      <div className="text-xs u-text-3">
                        步骤 {currentStep} / {totalSteps}
                      </div>
                    </div>
                  )}
                  
                  {/* 时间线（如果有 steps） */}
                  {steps.length > 0 && (
                    <Timeline 
                      phases={steps as StatsPhase[]} 
                      executionId={exec.id}
                    />
                  )}
                  
                  {/* 时间戳 */}
                  <div className="text-xs u-text-3 mt-2 flex gap-3">
                    <span>创建: {new Date(exec.createdAt).toLocaleString('zh-CN')}</span>
                    {exec.completedAt && (
                      <span>完成: {new Date(exec.completedAt).toLocaleString('zh-CN')}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 🆕 AC-5: 项目动态（WU 时间戳 + deliveredAt 前端拼装，倒序 ≤20 条） */}
      <div className="u-surface rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🕐 项目动态</h3>
        <ProjectActivity entries={timelineEntries} />
      </div>

      {/* 🛠️ 工具栏 */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setShowVscodeGuide(true)}
          className="px-4 py-2 u-accent-bg u-on-accent rounded u-hover-bg"
        >
          VS Code 打开
        </button>
        <button
          onClick={() => setShowCloudIdeGuide(true)}
          className="px-4 py-2 u-accent-bg u-on-accent rounded u-hover-bg"
        >
          ☁️ Cloud IDE
        </button>
        {archivableDocs.length > 0 && (
          <button
            onClick={handleArchive}
            disabled={archiveLoading}
            className="px-4 py-2 u-ok-bg u-on-accent rounded u-hover-bg disabled:opacity-50"
          >
            {archiveLoading ? '归档中...' : '📦 归档知识'}
          </button>
        )}
        <button
          onClick={handleCopyPath}
          className="px-4 py-2 u-surface-2 u-text rounded u-hover-bg"
        >
          {copySuccess ? '✓ 已复制' : '📋 复制路径'}
        </button>
      </div>

      {/* 🆕 AC-5: 知识库文档阅读抽屉 */}
      <DocReaderDrawer documentId={readerDocId} onClose={() => setReaderDocId(null)} />

      {/* VS Code 弹窗 */}
      {showVscodeGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-50 p-4 bg-black/50">
          <div className="u-surface rounded-xl max-w-md w-full shadow-2xl">
            <div className="p-4 border-b">
              <h3 className="text-lg font-bold">📋 VS Code Remote SSH</h3>
            </div>
            <div className="p-4 space-y-3">
              {vscodeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="px-2 py-1 text-xs rounded u-surface-2 u-hover-bg">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 提示：连接成功后 File → Open Folder → 粘贴路径</div>
            </div>
            <div className="p-4 border-t flex justify-end">
              <button onClick={() => setShowVscodeGuide(false)} className="px-4 py-2 u-surface-2 rounded u-hover-bg">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud IDE 弹窗 */}
      {showCloudIdeGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-50 p-4 bg-black/50">
          <div className="u-surface rounded-xl max-w-md w-full shadow-2xl">
            <div className="p-4 border-b">
              <h3 className="text-lg font-bold">☁️ Cloud IDE (浏览器中的 VS Code)</h3>
            </div>
            <div className="p-4 space-y-3">
              {cloudIdeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="px-2 py-1 text-xs rounded u-surface-2 u-hover-bg">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 Cloud IDE 内置终端和浏览器预览</div>
            </div>
            <div className="p-4 border-t flex justify-end">
              <button onClick={() => setShowCloudIdeGuide(false)} className="px-4 py-2 u-surface-2 rounded u-hover-bg">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectDetailPage;