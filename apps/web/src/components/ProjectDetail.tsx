// 项目详情弹窗组件
import { useState, useEffect } from 'react';
import { runtimeWorkflowApi, meetingApi, api } from '../api';
import { useNavigate } from 'react-router-dom';
import { toast } from '../utils/toast';

interface ProjectDetailProps {
  project: any;
  onClose: () => void;
}

export function ProjectDetail({ project, onClose }: ProjectDetailProps) {
  const navigate = useNavigate();
  const [executions, setExecutions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showCodeServerGuide, setShowCodeServerGuide] = useState(false);
  const [copiedStep, setCopiedStep] = useState<number | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  useEffect(() => {
    loadExecutions();
  }, [project.id]);

  const loadExecutions = async () => {
    try {
      const response = await runtimeWorkflowApi.listExecutions();
      const allExecs = response.data || response;
      const projectExecs = allExecs.filter((exec: any) => {
        const execProjectDir = exec.inputs?.project_dir || '';
        const execPath = execProjectDir.toLowerCase();
        const projectPathLower = (project.path || '').toLowerCase();
        const projectIdLower = (project.id || '').toLowerCase();
        
        return execPath.includes(projectPathLower) || 
               execPath.includes(projectIdLower) ||
               (exec.id && exec.id === project.id) ||
               projectIdLower.includes(exec.id?.toLowerCase() || '');
      });
      setExecutions(projectExecs);
    } catch (err) {
      console.error('Failed to load executions:', err);
      toast.error('加载执行记录失败');
    }
  };

  const handleIterate = async (workflowId: string = 'wf-iterate') => {
    const requirement = prompt(`在【${project.name}】上执行 ${workflowId}\n\n输入需求：`);
    if (!requirement) return;

    try {
      setLoading(true);
      const response = await runtimeWorkflowApi.execute(workflowId, {
        project_dir: project.path,
        requirement: requirement.trim(),
        create_branch: true
      });
      toast.success(`${workflowId} 已启动`);
      loadExecutions();
    } catch (error) {
      console.error('Failed to execute:', error);
      toast.error('执行失败');
    } finally {
      setLoading(false);
    }
  };

  // 发起讨论 - 创建关联任务的会议
  const handleStartDiscussion = async () => {
    try {
      setLoading(true);

      // 获取公司ID
      const companyId = localStorage.getItem('companyId') || '219fbcd4-6be4-4e60-955b-7eb49d6fda99';

      // 创建会议并关联当前任务
      const meetingData = {
        title: `任务讨论：${project.name}`,
        topic: `讨论任务执行过程中的问题和下一步计划`,
        companyId,
        taskId: project.id,  // 关联任务
        mode: 'sync',
        maxRounds: 3,
      };

      const response = await meetingApi.create(meetingData);
      const meeting = response.data || response;

      // 跳转到会议详情页
      navigate(`/meetings/${meeting.id}`);
      onClose();
    } catch (error) {
      console.error('Failed to create meeting:', error);
      toast.error('创建会议失败');
    } finally {
      setLoading(false);
    }
  };

  // 归档任务结果到知识库
  const handleArchive = async () => {
    try {
      setLoading(true);
      const response = await api.post(`/executions/${project.id}/archive`);
      toast.success('任务已归档');
    } catch (error: any) {
      console.error('Failed to archive:', error);
      toast.error('归档失败: ' + (error.response?.data?.error?.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  const copyStep = async (text: string, step: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStep(step);
      setTimeout(() => setCopiedStep(null), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error('复制失败');
    }
  };

  const steps = [
    { label: '快捷键', text: '⌘⇧P (Command+Shift+P)' },
    { label: '输入命令', text: 'Remote-SSH: Connect to Host' },
    { label: '输入主机', text: 'root@49.232.195.87' },
    { label: '打开目录', text: project.path },
  ];

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.path);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
      const textArea = document.createElement('textarea');
      textArea.value = project.path;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: 'rgba(0, 0, 0, 0.7)' }}>
      <div className="rounded-xl max-w-2xl w-full max-h-[90vh] overflow-auto shadow-2xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
        {/* 头部 */}
        <div className="p-6 sticky top-0 z-10" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl" style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' }}>
                📁
              </div>
              <div>
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{project.name}</h2>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{project.path}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-2xl transition-colors" style={{ color: 'var(--text-tertiary)' }}>×</button>
          </div>
        </div>

        {/* 信息区 */}
        <div className="p-6 space-y-6">
          {/* 基本信息 */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>类型</div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{project.type || '未知'}</div>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>迭代次数</div>
              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{project.iterations || 0}</div>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>创建时间</div>
              <div className="font-medium text-xs" style={{ color: 'var(--text-primary)' }}>{new Date(project.createdAt).toLocaleDateString('zh-CN')}</div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div>
            <h3 className="font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>执行工作流</h3>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => handleIterate('wf-iterate')} disabled={loading} className="btn btn-primary">🔄 完整迭代</button>
              <button onClick={() => handleIterate('wf-solo')} disabled={loading} className="btn btn-primary">⚡ 快速开发</button>
              <button onClick={() => handleIterate('wf-test')} disabled={loading} className="btn btn-primary">🧪 测试验证</button>
              <button onClick={() => handleIterate('wf-deploy')} disabled={loading} className="btn btn-primary">🚀 部署上线</button>
            </div>
          </div>

          {/* 协作讨论 */}
          <div>
            <h3 className="font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>协作讨论</h3>
            <button
              onClick={handleStartDiscussion}
              disabled={loading}
              className="w-full px-4 py-3 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2"
              style={{
                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(236, 72, 153, 0.15))',
                color: '#a78bfa',
                border: '1px solid rgba(139, 92, 246, 0.3)',
              }}
            >
              💬 发起讨论
              <span className="text-xs opacity-70">邀请角色讨论此任务</span>
            </button>
          </div>

          {/* 执行历史 */}
          <div>
            <h3 className="font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>执行历史</h3>
            {executions.length === 0 ? (
              <div className="text-center py-4 text-sm rounded-lg" style={{ color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)' }}>暂无执行记录</div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-auto">
                {executions.slice(0, 5).map((exec: any) => (
                  <div key={exec.id} className="p-3 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{exec.workflowName}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ 
                        background: exec.status === 'completed' ? 'rgba(16, 185, 129, 0.15)' : exec.status === 'running' ? 'rgba(0, 212, 255, 0.15)' : 'rgba(107, 118, 128, 0.15)',
                        color: exec.status === 'completed' ? 'var(--success)' : exec.status === 'running' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                      }}>{exec.status}</span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{new Date(exec.startedAt).toLocaleString('zh-CN')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="p-4 flex justify-between sticky bottom-0" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>
          <div className="flex gap-2">
            <button onClick={handleArchive} disabled={loading} className="px-4 py-2 rounded-lg text-sm transition-all" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', border: '1px solid rgba(16, 185, 129, 0.3)' }}>📦 归档知识库</button>
            <button onClick={() => setShowGuide(true)} className="px-4 py-2 rounded-lg text-sm transition-all" style={{ background: 'rgba(0, 212, 255, 0.1)', color: 'var(--accent-primary)', border: '1px solid rgba(0, 212, 255, 0.3)' }}>VS Code 打开</button>
            <button onClick={() => setShowCodeServerGuide(true)} className="px-4 py-2 rounded-lg text-sm transition-all" style={{ background: 'rgba(139, 92, 246, 0.1)', color: '#8b5cf6', border: '1px solid rgba(139, 92, 246, 0.3)' }}>☁️ Cloud IDE</button>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCopyPath} className="px-4 py-2 rounded-lg text-sm transition-all" style={{ background: copySuccess ? 'rgba(16, 185, 129, 0.1)' : 'var(--bg-tertiary)', color: copySuccess ? 'var(--success)' : 'var(--text-secondary)', border: '1px solid ' + (copySuccess ? 'var(--success)' : 'var(--border-subtle)') }}>{copySuccess ? '✓ 已复制' : '📋 复制路径'}</button>
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm transition-all" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>关闭</button>
          </div>
        </div>
      </div>

      {/* VS Code 操作指引弹窗 */}
      {showGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-[60] p-4" style={{ background: 'rgba(0, 0, 0, 0.7)' }}>
          <div className="rounded-xl max-w-md w-full shadow-2xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>📋 VS Code Remote SSH 操作步骤</h3>
            </div>
            <div className="p-4 space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="flex items-center justify-between gap-3 p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{i + 1}. {step.label}</div>
                    <div className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>{step.text}</div>
                  </div>
                  <button onClick={() => copyStep(step.text, i)} className="px-2 py-1 text-xs rounded shrink-0" style={{ background: 'var(--bg-elevated)', color: copiedStep === i ? 'var(--success)' : 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>{copiedStep === i ? '✓' : '复制'}</button>
                </div>
              ))}
              <div className="text-xs p-2 rounded" style={{ color: 'var(--text-tertiary)', background: 'rgba(0, 212, 255, 0.08)' }}>💡 提示：连接成功后选择 "File → Open Folder" 然后粘贴路径</div>
            </div>
            <div className="p-4 flex justify-end" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowGuide(false)} className="px-4 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud IDE 操作指引弹窗 */}
      {showCodeServerGuide && (
        <div className="fixed inset-0 flex items-center justify-center z-[60] p-4" style={{ background: 'rgba(0, 0, 0, 0.7)' }}>
          <div className="rounded-xl max-w-md w-full shadow-2xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>☁️ Cloud IDE (浏览器中的 VS Code)</h3>
            </div>
            <div className="p-4 space-y-3">
              {[
                { label: '步骤1: 在本地终端执行 SSH 隧道', text: 'ssh -L 8443:127.0.0.1:8443 root@49.232.195.87', step: 10 },
                { label: '步骤2: 浏览器打开', text: 'http://localhost:8443', step: 11 },
                { label: '步骤3: 输入密码', text: 'code2026', step: 12 },
                { label: '步骤4: 打开项目目录', text: project.path, step: 13 },
              ].map((item) => (
                <div key={item.step} className="flex items-center justify-between gap-3 p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{item.label}</div>
                    <div className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>{item.text}</div>
                  </div>
                  <button onClick={() => copyStep(item.text, item.step)} className="px-2 py-1 text-xs rounded shrink-0" style={{ background: 'var(--bg-elevated)', color: copiedStep === item.step ? 'var(--success)' : 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>{copiedStep === item.step ? '✓' : '复制'}</button>
                </div>
              ))}
              <div className="text-xs p-2 rounded" style={{ color: 'var(--text-tertiary)', background: 'rgba(139, 92, 246, 0.08)' }}>💡 提示：Cloud IDE 内置终端和浏览器预览，无需额外配置</div>
            </div>
            <div className="p-4 flex justify-end" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => setShowCodeServerGuide(false)} className="px-4 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
