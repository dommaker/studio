/**
 * Project 详情页 - GEN-005 + FL-013
 * 
 * 显示项目详情、PMO 号、关联 OKR、任务看板、项目进展、Token 消耗、会议历史、执行历史
 * 
 * 合并功能：
 * - VS Code 打开 + Cloud IDE 弹窗（迁移自 ProjectDetail.tsx）
 * - 归档知识库 + 复制路径（迁移自 ProjectDetail.tsx）
 * - 任务看板 + 项目进展统计（新增）
 * 
 * 页面为组合根：头部/知识库/交付/进展/看板/执行历史/工具栏/指南弹窗区块见 components/project-detail/
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { projectApi, api, type DeliveryStatus, type DeliveryGap } from '../api';
import { workunitApi } from '../api/workunit';
import { requirementApi, type RequirementChainWorkUnit } from '../api/requirements';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { knowledgeApi, type KnowledgeDoc } from '../api/knowledge';
import { ProjectPipeline } from '../components/pmo/ProjectPipeline';
import { ProjectActivity } from '../components/pmo/ProjectActivity';
import { buildProjectTimeline, type PipelineWorkUnit } from '../components/pmo/pipelineUtils';
import { DocReaderDrawer } from '../components/knowledge/DocReaderDrawer';
import { ProjectHeader } from '../components/project-detail/ProjectHeader';
import { KnowledgeCard } from '../components/project-detail/KnowledgeCard';
import { DeliveryCard } from '../components/project-detail/DeliveryCard';
import { ProgressCard } from '../components/project-detail/ProgressCard';
import { TaskBoard } from '../components/project-detail/TaskBoard';
import { ExecutionHistory } from '../components/project-detail/ExecutionHistory';
import { Toolbar } from '../components/project-detail/Toolbar';
import { GuideModals } from '../components/project-detail/GuideModals';
import { toast } from '../utils/toast';
import type { Project, Task } from '../components/project-detail/types';

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDoc[]>([]);  // 知识库文档
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 🆕 AC-5: 进度管道（REQ chain WU + agent 名册）/ 文档阅读器 / 原始需求折叠
  const [chainWus, setChainWus] = useState<RequirementChainWorkUnit[]>([]);
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

      // 🆕 AC-5: 进度管道数据（best-effort）——REQ 链路 WU（chain 自带 type/时间戳，§10 消 N+1）+ agent 名册
      if (projectData.reqAlias) {
        setChainLoading(true);
        try {
          const [chainRes, agentsRes] = await Promise.all([
            requirementApi.getChain(projectData.reqAlias),
            monitoringApi.getAgentSummary().catch(() => null),
          ]);
          setChainWus(chainRes.data?.data?.workunits ?? []);
          setAgents(agentsRes?.data?.agents ?? []);
        } catch {
          setChainWus([]);
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

  // 🆕 AC-5: 管道 WU 直接用 chain 条目（§10：type/时间戳由 chain 自带）；项目动态由 WU 时间戳 + deliveredAt 拼装
  const pipelineWus: PipelineWorkUnit[] = chainWus;
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
      <ProjectHeader
        project={project}
        projectId={projectId}
        requirementExpanded={requirementExpanded}
        setRequirementExpanded={setRequirementExpanded}
      />

      {/* 🆕 AC-5: 进度管道（REQ 链路五泳道，WU 小卡可点 → /workunits/:id） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🚦 进度管道</h3>
        <ProjectPipeline workunits={pipelineWus} agents={agents} loading={chainLoading} />
      </div>

      {/* 📚 知识库（AC-5：卡片点开抽屉阅读器） */}
      <KnowledgeCard documents={documents} setReaderDocId={setReaderDocId} />

      {/* 🆕 PMO-b: 交付（台账 + human-only 合并 + F6-c 缺口行动） */}
      {delivery && (
        <DeliveryCard
          delivery={delivery}
          delivering={delivering}
          deliverError={deliverError}
          gapActionPending={gapActionPending}
          handleGapAction={handleGapAction}
          handleDeliver={handleDeliver}
        />
      )}

      {/* 📈 项目进展（AS-010 增强） */}
      <ProgressCard
        project={project}
        tasks={tasks}
        delivery={delivery}
        progressStats={progressStats}
        tokenStats={tokenStats}
        evidenceGapSummary={evidenceGapSummary}
      />

      {/* 📋 任务看板 */}
      {tasks.length > 0 && (
        <TaskBoard tasks={tasks} tasksByStatus={tasksByStatus} />
      )}

      {/* 📦 执行历史（AS-010 增强） */}
      {project.Execution && project.Execution.length > 0 && (
        <ExecutionHistory project={project} />
      )}

      {/* 🆕 AC-5: 项目动态（WU 时间戳 + deliveredAt 前端拼装，倒序 ≤20 条） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🕐 项目动态</h3>
        <ProjectActivity entries={timelineEntries} />
      </div>

      {/* 🛠️ 工具栏 */}
      <Toolbar
        archivableDocs={archivableDocs}
        archiveLoading={archiveLoading}
        handleArchive={handleArchive}
        copySuccess={copySuccess}
        handleCopyPath={handleCopyPath}
        setShowVscodeGuide={setShowVscodeGuide}
        setShowCloudIdeGuide={setShowCloudIdeGuide}
      />

      {/* 🆕 AC-5: 知识库文档阅读抽屉 */}
      <DocReaderDrawer documentId={readerDocId} onClose={() => setReaderDocId(null)} />

      {/* VS Code + Cloud IDE 弹窗 */}
      <GuideModals
        showVscodeGuide={showVscodeGuide}
        showCloudIdeGuide={showCloudIdeGuide}
        setShowVscodeGuide={setShowVscodeGuide}
        setShowCloudIdeGuide={setShowCloudIdeGuide}
        copiedStep={copiedStep}
        copyStep={copyStep}
      />
    </div>
  );
}

export default ProjectDetailPage;
