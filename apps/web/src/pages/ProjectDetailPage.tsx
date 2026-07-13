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
import { projectApi, api } from '../api';
import { PmoNumberBadge } from '../components/PmoNumberBadge';
import { Timeline } from '../components/Timeline';
import { IronLawWarningBanner } from '../components/IronLawWarningBanner';
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
  worktreePath?: string;
  startedAt?: string;
  completedAt?: string;
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

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);  // 🆕 知识库文档
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // 弹窗状态
  const [showVscodeGuide, setShowVscodeGuide] = useState(false);
  const [showCloudIdeGuide, setShowCloudIdeGuide] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [copiedStep, setCopiedStep] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    loadData();
  }, [projectId]);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // 加载项目详情
      const projectRes = await projectApi.get(projectId!);
      const projectData = projectRes.data;
      setProject(projectData);
      
      // 加载任务列表
      const tasksRes = await api.get(`/tasks?projectId=${projectId}`);
      setTasks(tasksRes.data || []);
      
      // 🆕 加载知识库文档
      const docsRes = await api.get(`/knowledge/${projectId}`);
      setDocuments(docsRes.data?.documents || []);
      
      setLoading(false);
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

  // 归档知识库
  const handleArchive = async () => {
    if (!project) return;
    
    try {
      setArchiveLoading(true);
      const response = await api.post(`/executions/${project.id}/archive`);
      toast.success(`任务已归档！文件: ${response.data.fileName}`);
    } catch (err: any) {
      toast.error(`归档失败: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setArchiveLoading(false);
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

  // 计算 Token 消耗
  const getTokenStats = () => {
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

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">加载中...</div></div>;
  }

  if (error) {
    return <div className="flex items-center justify-center h-64"><div className="text-red-500">{error}</div></div>;
  }

  if (!project) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">项目不存在</div></div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <PmoNumberBadge pmoNumber={project.pmoNumber} status={project.status as any} size="lg" />
          <h1 className="text-2xl font-bold">{project.title}</h1>
        </div>
        <p className="text-gray-600">{project.description || '无描述'}</p>
        {project.OKR && (
          <div className="text-sm text-gray-500 mt-1">
            OKR: {project.OKR.title} ({project.OKR.quarter})
          </div>
        )}
      </div>

      {/* 📈 项目进展（AS-010 增强） */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">📈 项目进展</h3>
        
        {/* 主进度条 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1">
            <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${
                  progressStats.progress === 100 ? 'bg-green-500' :
                  progressStats.progress > 50 ? 'bg-gradient-to-r from-blue-400 to-blue-600' :
                  'bg-gradient-to-r from-yellow-400 to-yellow-500'
                }`}
                style={{ width: `${progressStats.progress}%` }}
              />
            </div>
          </div>
          <span className="text-2xl font-bold text-gray-700">{progressStats.progress}%</span>
        </div>
        
        {/* 统计卡片 */}
        <div className="grid grid-cols-5 gap-2">
          <div className="p-2 rounded-lg bg-green-50 text-center">
            <div className="text-lg font-bold text-green-600">{progressStats.completed}</div>
            <div className="text-xs text-gray-500">✅ 完成</div>
          </div>
          <div className="p-2 rounded-lg bg-blue-50 text-center">
            <div className="text-lg font-bold text-blue-600">{progressStats.inProgress}</div>
            <div className="text-xs text-gray-500">🔄 进行中</div>
          </div>
          <div className="p-2 rounded-lg bg-gray-50 text-center">
            <div className="text-lg font-bold text-gray-600">{progressStats.pending}</div>
            <div className="text-xs text-gray-500">⏳ 待领取</div>
          </div>
          <div className="p-2 rounded-lg bg-red-50 text-center">
            <div className="text-lg font-bold text-red-600">{progressStats.blocked}</div>
            <div className="text-xs text-gray-500">🚫 阻塞</div>
          </div>
          <div className="p-2 rounded-lg bg-purple-50 text-center">
            <div className="text-lg font-bold text-purple-600">{tokenStats.toLocaleString()}</div>
            <div className="text-xs text-gray-500">💰 Token</div>
          </div>
        </div>
        
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
                  isActive ? 'bg-blue-500 text-white ring-2 ring-blue-300' :
                  isPast ? 'bg-green-100 text-green-700' :
                  'bg-gray-100 text-gray-400'
                }`}>
                  {labels[s]}
                </div>
                {i < 3 && (
                  <div className={`text-lg ${isPast || isActive ? 'text-green-400' : 'text-gray-300'}`}>→</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* 📋 任务看板 */}
      {tasks.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3">📋 任务看板 ({tasks.length})</h3>
          
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
            <div className="p-3 rounded-lg bg-gray-50">
              <div className="text-xs text-gray-500 mb-2">待领取 ({tasksByStatus.pending.length})</div>
              <div className="space-y-2">
                {tasksByStatus.pending.map(task => (
                  <div key={task.id} className="p-2 bg-white rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs text-gray-400">{task.assignee}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 进行中 */}
            <div className="p-3 rounded-lg bg-blue-50">
              <div className="text-xs text-blue-500 mb-2">进行中 ({tasksByStatus.inProgress.length})</div>
              <div className="space-y-2">
                {tasksByStatus.inProgress.map(task => (
                  <div key={task.id} className="p-2 bg-white rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs text-gray-400">{task.ClaimedBy?.name || task.assignee}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 已完成 */}
            <div className="p-3 rounded-lg bg-green-50">
              <div className="text-xs text-green-500 mb-2">已完成 ({tasksByStatus.completed.length})</div>
              <div className="space-y-2">
                {tasksByStatus.completed.map(task => (
                  <div key={task.id} className="p-2 bg-white rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs text-gray-400">✅</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 阻塞 */}
            <div className="p-3 rounded-lg bg-red-50">
              <div className="text-xs text-red-500 mb-2">阻塞 ({tasksByStatus.blocked.length})</div>
              <div className="space-y-2">
                {tasksByStatus.blocked.map(task => (
                  <div key={task.id} className="p-2 bg-white rounded text-sm">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs text-red-400">依赖: {task.dependsOn.length}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 📚 知识库 */}
      {documents.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3">📚 知识库 ({documents.length})</h3>
          <div className="grid grid-cols-3 gap-2">
            {/* requirement */}
            <div className="p-3 rounded-lg bg-yellow-50">
              <div className="text-xs text-yellow-600 mb-2">📄 需求文档</div>
              <div className="space-y-1">
                {documents.filter(d => d.type === 'requirement').map(doc => (
                  <div key={doc.id} className="p-2 bg-white rounded text-sm cursor-pointer hover:bg-yellow-100">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-gray-400">v{doc.version}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* design/spec */}
            <div className="p-3 rounded-lg bg-blue-50">
              <div className="text-xs text-blue-600 mb-2">📐 设计/规范</div>
              <div className="space-y-1">
                {documents.filter(d => d.type === 'design' || d.type === 'spec').map(doc => (
                  <div key={doc.id} className="p-2 bg-white rounded text-sm cursor-pointer hover:bg-blue-100">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-gray-400">{doc.type} v{doc.version}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* execution/archive */}
            <div className="p-3 rounded-lg bg-purple-50">
              <div className="text-xs text-purple-600 mb-2">📦 执行/归档</div>
              <div className="space-y-1">
                {documents.filter(d => ['execution', 'archive'].includes(d.type)).map(doc => (
                  <div key={doc.id} className="p-2 bg-white rounded text-sm cursor-pointer hover:bg-purple-100">
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-gray-400">{doc.type}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 📦 执行历史（AS-010 增强） */}
      {project.Execution && project.Execution.length > 0 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3">📦 执行历史 ({project.Execution.length})</h3>
          <div className="space-y-3">
            {project.Execution.slice(0, 5).map(exec => {
              // 解析 steps 数据
              const steps = exec.steps ? (Array.isArray(exec.steps) ? exec.steps : Object.values(exec.steps)) : [];
              const currentStep = exec.currentStep || 0;
              const totalSteps = exec.totalSteps || steps.length || 1;
              const progressPercent = Math.round((currentStep / totalSteps) * 100);
              
              return (
                <div key={exec.id} className="p-3 bg-gray-50 rounded border border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-700 text-sm font-mono">{exec.id.slice(0, 8)}</span>
                      {exec.workflowName && (
                        <span className="text-xs text-gray-400">{exec.workflowName}</span>
                      )}
                    </div>
                    <span className={`text-xs px-2 py-1 rounded ${
                      exec.status === 'completed' || exec.status === 'succeeded' ? 'bg-green-100 text-green-600' :
                      exec.status === 'running' ? 'bg-blue-100 text-blue-600' :
                      exec.status === 'failed' ? 'bg-red-100 text-red-600' :
                      'bg-gray-100 text-gray-600'
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
                        <div className="flex-1 bg-gray-200 rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full transition-all ${
                              exec.status === 'running' ? 'bg-gradient-to-r from-blue-400 to-blue-600' :
                              exec.status === 'failed' ? 'bg-red-500' : 'bg-green-500'
                            }`}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{progressPercent}%</span>
                      </div>
                      <div className="text-xs text-gray-400">
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
                  <div className="text-xs text-gray-400 mt-2 flex gap-3">
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

      {/* 🛠️ 工具栏 */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setShowVscodeGuide(true)}
          className="px-4 py-2 bg-cyan-500 text-white rounded hover:bg-cyan-600"
        >
          VS Code 打开
        </button>
        <button
          onClick={() => setShowCloudIdeGuide(true)}
          className="px-4 py-2 bg-violet-500 text-white rounded hover:bg-violet-600"
        >
          ☁️ Cloud IDE
        </button>
        <button
          onClick={handleArchive}
          disabled={archiveLoading}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
        >
          {archiveLoading ? '归档中...' : '📦 归档'}
        </button>
        <button
          onClick={handleCopyPath}
          className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
        >
          {copySuccess ? '✓ 已复制' : '📋 复制路径'}
        </button>
      </div>

      {/* VS Code 弹窗 */}
      {showVscodeGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-50 p-4 bg-black/50">
          <div className="bg-white rounded-xl max-w-md w-full shadow-2xl">
            <div className="p-4 border-b">
              <h3 className="text-lg font-bold">📋 VS Code Remote SSH</h3>
            </div>
            <div className="p-4 space-y-3">
              {vscodeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                  <span className="w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded bg-blue-50 text-blue-600">💡 提示：连接成功后 File → Open Folder → 粘贴路径</div>
            </div>
            <div className="p-4 border-t flex justify-end">
              <button onClick={() => setShowVscodeGuide(false)} className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud IDE 弹窗 */}
      {showCloudIdeGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-50 p-4 bg-black/50">
          <div className="bg-white rounded-xl max-w-md w-full shadow-2xl">
            <div className="p-4 border-b">
              <h3 className="text-lg font-bold">☁️ Cloud IDE (浏览器中的 VS Code)</h3>
            </div>
            <div className="p-4 space-y-3">
              {cloudIdeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 bg-gray-50 rounded">
                  <span className="w-6 h-6 bg-violet-500 text-white rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded bg-violet-50 text-violet-600">💡 Cloud IDE 内置终端和浏览器预览</div>
            </div>
            <div className="p-4 border-t flex justify-end">
              <button onClick={() => setShowCloudIdeGuide(false)} className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectDetailPage;