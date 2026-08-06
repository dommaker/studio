/**
 * Project 详情页 - GEN-005 + FL-013
 *
 * 显示项目详情、PMO 号、关联 OKR、进度管道、知识库、交付面板（DeliveryPanel）、项目进展、项目动态
 *
 * 合并功能：
 * - VS Code 打开 + Cloud IDE 弹窗（迁移自 ProjectDetail.tsx）
 * - 归档知识库 + 复制路径（迁移自 ProjectDetail.tsx）
 *
 * Card 7（2026-08）：老 Task 看板 / 执行历史 / 双轨统计已删除（WU 链路为唯一口径）；
 * 后端 /tasks API 与数据保留（存量 16 条 legacy task 仍可从 API 访问）。
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectApi, api, type DeliveryStatus } from '../api';
import { requirementApi, type RequirementChainWorkUnit } from '../api/requirements';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { knowledgeApi, type KnowledgeDoc } from '../api/knowledge';
import { maintenanceApi } from '../api/maintenance';
import { PmoNumberBadge } from '../components/PmoNumberBadge';
import { ProjectPipeline } from '../components/pmo/ProjectPipeline';
import { ProjectActivity } from '../components/pmo/ProjectActivity';
import { DeliveryPanel } from '../components/pmo/DeliveryPanel';
import { buildProjectTimeline, type PipelineWorkUnit } from '../components/pmo/pipelineUtils';
import { DocReaderDrawer } from '../components/knowledge/DocReaderDrawer';
import { ManualTaskButton } from '../components/ui';
import { toast } from '../utils/toast';

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

  // 🆕 PMO-b: 交付台账（delivery 数据由页面持有：管道时间线 / 进展卡 / 证据警告条共用；
  // 交互（缺口行动 / 交付合并）在 DeliveryPanel 内，经 onRefresh 回调刷新）
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);

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

  // 🆕 F6-c: 重新拉台账 + 全量数据（缺口行动/交付成功后由 DeliveryPanel 回调）
  const refreshDelivery = async () => {
    if (!projectId) return;
    try {
      const deliveryRes = await projectApi.getDelivery(projectId);
      setDelivery(deliveryRes.data);
    } catch { /* best-effort */ }
    loadData();
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
          className="btn btn-ghost btn-sm mb-2"
        >
          ← 返回
        </button>
        <div className="flex items-center gap-3 mb-2">
          <PmoNumberBadge pmoNumber={project.pmoNumber} status={project.status as any} size="lg" />
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
            <ManualTaskButton
              label="🔍 模式识别"
              onRun={async () => {
                const r = await maintenanceApi.runMesoEvolution(projectId!);
                return `识别完成：发现 ${r.total} 个模式`;
              }}
            />
          </div>
        </div>
      </div>

      {/* 🆕 AC-5: 进度管道（REQ 链路五泳道，WU 小卡可点 → /workunits/:id） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">🚦 进度管道</h3>
        <ProjectPipeline workunits={pipelineWus} agents={agents} loading={chainLoading} />
      </div>

      {/* 📚 知识库（AC-5：卡片点开抽屉阅读器） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">📚 知识库 ({documents.length})</h3>
        {documents.length === 0 ? (
          <div className="text-sm u-text-3">暂无文档产出</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {/* requirement */}
            <div className="p-3 rounded u-warn-dim">
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
            <div className="p-3 rounded u-accent-dim">
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
            <div className="p-3 rounded u-accent-dim">
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

      {/* 🆕 PMO-b: 交付（台账 + human-only 合并 + F6-c 缺口行动）——Card 7 抽取为 DeliveryPanel */}
      {delivery && (
        <DeliveryPanel projectId={projectId!} delivery={delivery} onRefresh={refreshDelivery} />
      )}

      {/* 📈 项目进展（AS-010 增强） */}
      <div className="card p-4 mb-6">
        <h3 className="text-sm font-medium u-text-2 mb-3">📈 项目进展</h3>
        
        {/* 主进度条 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1">
            <div className="h-4 u-surface-2 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${
                  progress === 100 ? 'u-ok-bg' :
                  progress > 50 ? 'u-accent-bg' :
                  'u-warn-bg'
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <span className="text-2xl font-bold u-text">{progress}%</span>
        </div>
        
        {/* 统计卡片：WU 链路六卡（Card 7：老 Task 链路五卡已随双轨删除） */}
        {delivery && (
          <div className="grid grid-cols-6 gap-2">
            <div className="p-2 rounded u-ok-dim text-center">
              <div className="text-lg font-bold u-ok">{delivery.wu.finished}</div>
              <div className="text-xs u-text-2">✅ 完成</div>
            </div>
            <div className="p-2 rounded u-warn-dim text-center">
              <div className="text-lg font-bold u-warn">{delivery.wu.byStatus.inReview}</div>
              <div className="text-xs u-text-2">👀 待验收</div>
            </div>
            <div className="p-2 rounded u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{delivery.wu.byStatus.active}</div>
              <div className="text-xs u-text-2">🔄 进行中</div>
            </div>
            <div className="p-2 rounded u-surface-2 text-center">
              <div className="text-lg font-bold u-text-2">{delivery.wu.byStatus.unassigned}</div>
              <div className="text-xs u-text-2">⏳ 待领取</div>
            </div>
            <div className="p-2 rounded u-err-dim text-center">
              <div className="text-lg font-bold u-err">{delivery.wu.byStatus.blocked}</div>
              <div className="text-xs u-text-2">🚫 阻塞</div>
            </div>
            <div className="p-2 rounded u-accent-dim text-center">
              <div className="text-lg font-bold u-accent">{delivery.tokens.toLocaleString()}</div>
              <div className="text-xs u-text-2">💰 Token</div>
            </div>
          </div>
        )}

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
        {archivableDocs.length > 0 && (
          <button
            onClick={handleArchive}
            disabled={archiveLoading}
            className="btn u-ok-bg u-on-accent u-hover-bg"
          >
            {archiveLoading ? '归档中...' : '📦 归档知识'}
          </button>
        )}
        <button
          onClick={handleCopyPath}
          className="btn btn-secondary"
        >
          {copySuccess ? '✓ 已复制' : '📋 复制路径'}
        </button>
      </div>

      {/* 🆕 AC-5: 知识库文档阅读抽屉 */}
      <DocReaderDrawer documentId={readerDocId} onClose={() => setReaderDocId(null)} />

      {/* VS Code 弹窗 */}
      {showVscodeGuide && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 448 }}>
            <div className="modal-header">
              <h3 className="modal-title">📋 VS Code Remote SSH</h3>
            </div>
            <div className="modal-body space-y-3">
              {vscodeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="btn btn-sm btn-secondary">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 提示：连接成功后 File → Open Folder → 粘贴路径</div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowVscodeGuide(false)} className="btn btn-secondary">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud IDE 弹窗 */}
      {showCloudIdeGuide && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 448 }}>
            <div className="modal-header">
              <h3 className="modal-title">☁️ Cloud IDE (浏览器中的 VS Code)</h3>
            </div>
            <div className="modal-body space-y-3">
              {cloudIdeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="btn btn-sm btn-secondary">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 Cloud IDE 内置终端和浏览器预览</div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCloudIdeGuide(false)} className="btn btn-secondary">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectDetailPage;