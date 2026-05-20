// 侧边栏组件 - 深色主题
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../stores';
import { ProjectDetail } from './ProjectDetail';
import { runtimeWorkflowApi } from '../api';
import '../styles/theme.css';

interface SidebarProps {
  onOpenAgentRegistry?: () => void;
  onOpenExecutionHistory?: () => void;
  onOpenSettings?: () => void;
}

const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: 'rgba(245, 158, 11, 0.1)', text: 'var(--warning)', label: '草稿' },
  published: { bg: 'rgba(16, 185, 129, 0.1)', text: 'var(--success)', label: '已发布' },
  archived: { bg: 'var(--bg-tertiary)', text: 'var(--text-tertiary)', label: '已归档' },
};

export function Sidebar({ onOpenAgentRegistry, onOpenExecutionHistory, onOpenSettings }: SidebarProps) {
  const { 
    workflows, 
    selectedWorkflow, 
    selectWorkflow,
    createWorkflow,
    sidebarOpen,
    runtimeWorkflows,
    loadRuntimeWorkflows,
    executeRuntimeWorkflow,
  } = useAppStore();
  
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<'studio' | 'runtime' | 'projects'>('runtime');
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<any>(null);
  
  // 加载 runtime workflows
  useEffect(() => {
    loadRuntimeWorkflows();
    // 加载项目列表
    runtimeWorkflowApi.listProjects().then(({ data }) => {
      setProjects(data);
    }).catch(console.error);
  }, [loadRuntimeWorkflows]);
  
  // 排序工作流：开发相关优先
  const sortedWorkflows = [...runtimeWorkflows].sort((a, b) => {
    const getPriority = (id: string) => {
      // 开发流程（最高优先级）
      if (id.startsWith('wf-') && !id.includes('test')) return 0;
      // 需求/架构
      if (id.includes('require') || id.includes('arch')) return 1;
      // 前后端开发
      if (id.includes('frontend') || id.includes('backend')) return 2;
      // 测试工作流（最低优先级）
      if (id.startsWith('test-') || id.includes('test')) return 10;
      // 其他
      return 5;
    };
    return getPriority(a.id) - getPriority(b.id);
  });

  const handleCreateWorkflow = async () => {
    const name = prompt('输入工作流名称');
    if (!name) return;
    
    setIsCreating(true);
    try {
      const workflow = await createWorkflow(name);
      selectWorkflow(workflow);
    } catch (error) {
      console.error('Failed to create workflow:', error);
      alert('创建失败');
    } finally {
      setIsCreating(false);
    }
  };

  if (!sidebarOpen) return null;

  return (
    <div className="w-72 overflow-auto flex flex-col" style={{ background: 'var(--bg-elevated)', borderRight: '1px solid var(--border-subtle)' }}>
      {/* Logo 区域 */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'linear-gradient(to right, rgba(99, 102, 241, 0.05), rgba(139, 92, 246, 0.05))' }}>
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-xl"
            style={{ background: 'linear-gradient(to bottom right, #6366f1, #8b5cf6)' }}
          >
            🔧
          </div>
          <div>
            <div className="font-bold" style={{ color: 'var(--text-primary)' }}>Agent Studio</div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>工作流可视化编辑器</div>
          </div>
        </div>
      </div>

      {/* 工作流列表 */}
      <div className="flex-1 p-4 overflow-auto">
        {/* Tab 切换 */}
        <div className="flex gap-1 mb-3 p-1 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
          <button
            onClick={() => setActiveTab('runtime')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'runtime' ? 'shadow-sm' : ''
            }`}
            style={{
              background: activeTab === 'runtime' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'runtime' ? 'var(--accent-primary)' : 'var(--text-secondary)'
            }}
          >
            🚀 模板
          </button>
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'projects' ? 'shadow-sm' : ''
            }`}
            style={{
              background: activeTab === 'projects' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'projects' ? 'var(--accent-primary)' : 'var(--text-secondary)'
            }}
          >
            📁 项目
          </button>
          <button
            onClick={() => setActiveTab('studio')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'studio' ? 'shadow-sm' : ''
            }`}
            style={{
              background: activeTab === 'studio' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'studio' ? 'var(--accent-primary)' : 'var(--text-secondary)'
            }}
          >
            📝 自定义
          </button>
        </div>

        {activeTab === 'runtime' ? (
          /* Runtime Workflows (YAML 模板) */
          <div className="space-y-2">
            {runtimeWorkflows.length === 0 ? (
              <div className="text-center py-8 text-sm rounded-xl border-2 border-dashed"
                style={{ 
                  background: 'var(--bg-tertiary)', 
                  borderColor: 'var(--border-default)', 
                  color: 'var(--text-tertiary)' 
                }}
              >
                <div className="text-3xl mb-2">🔌</div>
                <div>无法连接 agent-runtime</div>
                <div className="text-xs mt-1">检查服务是否启动</div>
              </div>
            ) : (
              sortedWorkflows.map((workflow) => (
                <div key={workflow.id} className="relative">
                  <button
                    className="w-full text-left p-3 rounded-xl border-2 border-transparent transition-all group"
                    style={{ 
                      background: 'linear-gradient(to right, rgba(99, 102, 241, 0.05), rgba(139, 92, 246, 0.05))'
                    }}
                    onClick={async () => {
                      // 输入需求
                      const input = prompt(
                        '输入需求描述：\n\n' +
                        '示例：\n' +
                        '- 开发一个坦克大战游戏\n' +
                        '- 创建一个 Todo List 应用\n' +
                        '- 实现用户登录功能'
                      );
                      
                      // 用户取消，不执行
                      if (input === null) {
                        return;
                      }
                      
                      // 确认执行
                      const confirmMsg = input.trim() 
                        ? `确认执行工作流？\n\n工作流: ${workflow.name}\n需求: ${input}\n\n代码将保存到项目目录`
                        : `确认执行工作流？\n\n工作流: ${workflow.name}\n需求: (未指定)\n\n代码将保存到项目目录`;
                      
                      if (!confirm(confirmMsg)) {
                        return;
                      }
                      
                      // 执行工作流
                      try {
                        const result = await executeRuntimeWorkflow(workflow.id, { requirement: input.trim() || '默认任务' });
                        
                        // 提示用户
                        alert(`✅ 工作流已启动！\n\n执行ID: ${result.id}\n工作流: ${workflow.name}\n\n进度将推送到 Discord`);
                      } catch (error) {
                        console.error('Failed to execute workflow:', error);
                        alert('❌ 执行失败：' + (error as Error).message);
                      }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{workflow.name}</div>
                      {(workflow.stepIds?.length || workflow.steps?.length || 0) > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full ml-2 shrink-0"
                          style={{ background: 'var(--accent-glow)', color: 'var(--accent-primary)' }}
                        >
                          {workflow.stepIds?.length || workflow.steps?.length || 0} 步
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-1 truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {workflow.description || workflow.id}
                    </div>
                    
                    {/* 步骤流程（hover 时在按钮内展开） */}
                    {(workflow.stepIds?.length || 0) > 0 && (
                      <div className="mt-2 pt-2 max-h-0 overflow-hidden group-hover:max-h-96 transition-all duration-300"
                        style={{ borderTop: '1px solid var(--border-subtle)' }}
                      >
                        <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>执行流程：</div>
                        <div className="flex flex-wrap gap-1">
                          {(() => {
                            // 步骤描述映射
                            const stepDescriptions: Record<string, string> = {
                              'requirements': '需求分析',
                              'architecture': '架构设计',
                              'frontend': '前端开发',
                              'backend': '后端开发',
                              'test': '测试验证',
                              'test-e2e': '端到端测试',
                              'deploy': '部署上线',
                              'rdqa': '需求审核',
                              'api-contract': 'API契约',
                              'shared-types': '类型定义',
                              'integration-test': '集成测试',
                              'review': '代码审查',
                              'analyze-code': '代码分析',
                              'analyze-perf': '性能分析',
                              'analyze-deps': '依赖分析',
                              'frontend-fast': '快速前端',
                              'backend-fast': '快速后端',
                              'read': '读取文件',
                              'write': '写入文件',
                              'load-tasks': '加载任务',
                              'develop-infrastructure': '基础设施',
                              'develop-phases': '开发阶段',
                              'run-tests': '运行测试',
                              'review-code': '代码审查',
                              'generate-report': '生成报告',
                            };
                            
                            // 使用 stepIds（API 返回的格式）
                            const stepIds = workflow.stepIds || [];
                            return stepIds.map((stepId, idx) => (
                              <span key={`${workflow.id}-${stepId}-${idx}`} className="inline-flex items-center text-xs">
                                <span className="px-1.5 py-0.5 rounded"
                                  style={{ 
                                    background: 'var(--bg-tertiary)', 
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-secondary)'
                                  }}
                                >
                                  {stepDescriptions[stepId] || stepId}
                                </span>
                                {idx < stepIds.length - 1 && (
                                  <span className="mx-0.5" style={{ color: 'var(--text-muted)' }}>→</span>
                                )}
                              </span>
                            ));
                          })()}
                        </div>
                      </div>
                    )}
                  </button>
                </div>
              ))
            )}
          </div>
        ) : activeTab === 'projects' ? (
          <div className="space-y-2">
            {projects.length === 0 ? (
              <div className="text-center py-8 text-sm rounded-xl border-2 border-dashed"
                style={{ 
                  background: 'var(--bg-tertiary)', 
                  borderColor: 'var(--border-default)', 
                  color: 'var(--text-tertiary)' 
                }}
              >
                <div className="text-3xl mb-2">📁</div>
                <div>暂无项目</div>
                <div className="text-xs mt-1">执行工作流后自动注册项目</div>
              </div>
            ) : (
              projects.map((project: any) => (
                <div key={project.id} className="relative group">
                  <button
                    className="w-full text-left p-3 rounded-xl border-2 border-transparent transition-all"
                    style={{ background: 'linear-gradient(to right, rgba(16, 185, 129, 0.05), rgba(5, 150, 105, 0.05))' }}
                    onClick={() => setSelectedProject(project)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{project.name}</div>
                      <span className="text-xs px-2 py-0.5 rounded-full ml-2"
                        style={{ 
                          background: project.type === 'frontend' ? 'rgba(59, 130, 246, 0.1)' :
                                     project.type === 'backend' ? 'rgba(139, 92, 246, 0.1)' :
                                     'var(--bg-tertiary)',
                          color: project.type === 'frontend' ? 'var(--info)' :
                                 project.type === 'backend' ? 'var(--accent-primary)' :
                                 'var(--text-secondary)'
                        }}
                      >
                        {project.type || '项目'}
                      </span>
                    </div>
                    <div className="text-xs mt-1 truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {project.path}
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      迭代次数: {project.iterations || 0}
                    </div>
                  </button>
                  
                  {/* 删除按钮 */}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (confirm(`确认删除项目注册？\n\n${project.name}\n\n注意：只会删除注册信息，不会删除项目文件`)) {
                        try {
                          await runtimeWorkflowApi.deleteProject(project.id);
                          // 重新加载项目列表
                          const { data } = await runtimeWorkflowApi.listProjects();
                          setProjects(data);
                        } catch (error) {
                          console.error('Failed to delete project:', error);
                        }
                      }
                    }}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-xs p-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Studio Workflows (用户创建) */
          <div className="space-y-2">
            {workflows.length === 0 ? (
              <div className="text-center py-8 text-sm rounded-xl border-2 border-dashed"
                style={{ 
                  background: 'var(--bg-tertiary)', 
                  borderColor: 'var(--border-default)', 
                  color: 'var(--text-tertiary)' 
                }}
              >
                <div className="text-3xl mb-2">📝</div>
                <div>暂无自定义工作流</div>
                <div className="text-xs mt-1">点击下方按钮创建</div>
              </div>
            ) : (
              workflows.map((workflow) => {
                const status = statusConfig[workflow.status || 'draft'] || statusConfig.draft;
                return (
                  <button
                    key={workflow.id}
                    className="w-full text-left p-3 rounded-xl transition-all"
                    style={{
                      background: selectedWorkflow?.id === workflow.id 
                        ? 'linear-gradient(to right, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.1))'
                        : 'var(--bg-tertiary)',
                      border: selectedWorkflow?.id === workflow.id 
                        ? '2px solid var(--accent-primary)' 
                        : '2px solid transparent'
                    }}
                    onClick={() => selectWorkflow(workflow)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{workflow.name}</div>
                      <span className="text-xs px-2 py-0.5 rounded-full"
                        style={{ background: status.bg, color: status.text }}
                      >
                        {status.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span>📦 {workflow.nodes?.length || 0} 节点</span>
                      <span>•</span>
                      <span>v{workflow.version}</span>
                    </div>
                  </button>
                );
              })
            )}
            
            <button 
              onClick={handleCreateWorkflow}
              disabled={isCreating}
              className="mt-4 w-full py-3 text-sm text-white rounded-xl font-medium flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(to right, #6366f1, #8b5cf6)' }}
            >
              <span className="text-lg">+</span> 新建工作流
            </button>
          </div>
        )}
      </div>

      {/* 底部工具 */}
      <div className="p-2 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)' }}>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenAgentRegistry?.();
          }}
          className="w-full py-2.5 text-sm text-left px-3 rounded-lg flex items-center gap-2 cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="text-lg">🤖</span>
          <span>Agent 注册</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenExecutionHistory?.();
          }}
          className="w-full py-2.5 text-sm text-left px-3 rounded-lg flex items-center gap-2 cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="text-lg">📜</span>
          <span>执行历史</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenSettings?.();
          }}
          className="w-full py-2.5 text-sm text-left px-3 rounded-lg flex items-center gap-2 cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="text-lg">⚙️</span>
          <span>设置</span>
        </button>
      </div>
      
      {/* 项目详情弹窗 */}
      {selectedProject && (
        <ProjectDetail
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
        />
      )}
    </div>
  );
}
