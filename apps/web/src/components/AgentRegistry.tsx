// Agent Registry 组件（深色主题）
import { useState, useEffect } from 'react';
import '../styles/theme.css';

interface Agent {
  id: string;
  name: string;
  emoji?: string;
  description: string;
  version?: string;
  capabilities?: string[];
  endpoint?: string;
  status?: 'online' | 'offline';
}

interface AgentRegistryProps {
  onClose: () => void;
}

export function AgentRegistry({ onClose }: AgentRegistryProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  
  // 加载 agents
  useEffect(() => {
    loadAgents();
  }, []);
  
  const loadAgents = async () => {
    try {
      setLoading(true);
      // 直接使用默认数据（匹配实际 Pipeline）
      setAgents(getDefaultAgents());
      setError(null);
    } catch (err) {
      console.error('Failed to load agents:', err);
      setError('无法加载 Agent 列表');
      setAgents(getDefaultAgents());
    } finally {
      setLoading(false);
    }
  };
  
  // 默认 Agent 列表（匹配工作流 Pipeline）
  const getDefaultAgents = (): Agent[] => [
    {
      id: 'requirements',
      name: '需求分析师',
      emoji: '📋',
      description: '分析用户需求，输出需求文档',
      version: '1.0.0',
      capabilities: ['需求分析', '文档编写', '用例设计'],
      status: 'online',
    },
    {
      id: 'architecture',
      name: '架构设计师',
      emoji: '🏗️',
      description: '设计系统架构，输出技术方案',
      version: '1.0.0',
      capabilities: ['架构设计', '技术选型', '系统设计'],
      status: 'online',
    },
    {
      id: 'frontend',
      name: '前端开发',
      emoji: '🎨',
      description: '实现前端界面和交互逻辑',
      version: '1.0.0',
      capabilities: ['React', 'Vue', 'CSS', 'TypeScript'],
      status: 'online',
    },
    {
      id: 'backend',
      name: '后端开发',
      emoji: '⚙️',
      description: '实现后端 API 和业务逻辑',
      version: '1.0.0',
      capabilities: ['Node.js', 'Python', 'API设计', '数据库'],
      status: 'online',
    },
    {
      id: 'test',
      name: '测试工程师',
      emoji: '🧪',
      description: '编写单元测试和集成测试',
      version: '1.0.0',
      capabilities: ['单元测试', '集成测试', '测试覆盖'],
      status: 'online',
    },
    {
      id: 'test-e2e',
      name: 'E2E 测试',
      emoji: '🔬',
      description: '端到端测试，验证前后端联调',
      version: '1.0.0',
      capabilities: ['E2E测试', 'Playwright', 'Cypress'],
      status: 'online',
    },
    {
      id: 'deploy',
      name: '部署工程师',
      emoji: '🚀',
      description: '构建和部署应用',
      version: '1.0.0',
      capabilities: ['Docker', 'CI/CD', 'Kubernetes'],
      status: 'online',
    },
    {
      id: 'api-contract',
      name: 'API 契约',
      emoji: '📄',
      description: '生成 OpenAPI 规范文档',
      version: '1.0.0',
      capabilities: ['OpenAPI', 'API设计', '文档生成'],
      status: 'online',
    },
    {
      id: 'shared-types',
      name: '类型定义',
      emoji: '📦',
      description: '生成共享类型定义',
      version: '1.0.0',
      capabilities: ['TypeScript', '类型生成', '代码生成'],
      status: 'online',
    },
    {
      id: 'rdqa',
      name: 'RDQA',
      emoji: '🔍',
      description: '需求质量审核',
      version: '1.0.0',
      capabilities: ['需求评审', '质量检查', '风险评估'],
      status: 'online',
    },
    {
      id: 'review',
      name: '代码审查',
      emoji: '👀',
      description: '代码质量审查',
      version: '1.0.0',
      capabilities: ['代码审查', '最佳实践', '安全检查'],
      status: 'online',
    },
    {
      id: 'analyze-code',
      name: '代码分析',
      emoji: '📊',
      description: '静态代码分析',
      version: '1.0.0',
      capabilities: ['代码分析', '复杂度检测', '重复代码'],
      status: 'online',
    },
    {
      id: 'analyze-perf',
      name: '性能分析',
      emoji: '⚡',
      description: '性能瓶颈分析',
      version: '1.0.0',
      capabilities: ['性能分析', '内存泄漏', '优化建议'],
      status: 'online',
    },
    {
      id: 'analyze-deps',
      name: '依赖分析',
      emoji: '🔗',
      description: '依赖关系和安全检查',
      version: '1.0.0',
      capabilities: ['依赖分析', '漏洞扫描', '版本检查'],
      status: 'online',
    },
    {
      id: 'frontend-fast',
      name: '快速前端',
      emoji: '⚡',
      description: '快速前端开发模式',
      version: '1.0.0',
      capabilities: ['快速开发', '原型', 'MVP'],
      status: 'online',
    },
    {
      id: 'backend-fast',
      name: '快速后端',
      emoji: '⚡',
      description: '快速后端开发模式',
      version: '1.0.0',
      capabilities: ['快速开发', '原型', 'MVP'],
      status: 'online',
    },
  ];
  
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden shadow-2xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
        {/* Header */}
        <div className="p-6 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>🤖 Agent Registry</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                管理和发现可用的 Agent
              </p>
            </div>
            <button
              onClick={onClose}
              className="hover:opacity-70 text-2xl"
              style={{ color: 'var(--text-tertiary)' }}
            >
              ×
            </button>
          </div>
        </div>
        
        {/* Content */}
        <div className="p-6 overflow-auto max-h-[calc(90vh-180px)]">
          {loading ? (
            <div className="text-center py-12 flex justify-center">
              <div className="loading-spinner"></div>
            </div>
          ) : error ? (
            <div className="text-center py-12" style={{ color: 'var(--error)' }}>
              {error}
              <button
                onClick={loadAgents}
                className="ml-2 hover:underline"
                style={{ color: 'var(--accent-primary)' }}
              >
                重试
              </button>
            </div>
          ) : agents.length === 0 ? (
            <div className="text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
              暂无 Agent
            </div>
          ) : (
            <div className="flex gap-4 h-full">
              {/* 左侧网格列表 */}
              <div className="flex-1 grid grid-cols-2 md:grid-cols-3 gap-2 overflow-auto content-start">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent)}
                    className={`rounded-lg p-3 border transition-all cursor-pointer ${
                      selectedAgent?.id === agent.id 
                        ? 'card-glow' 
                        : ''
                    }`}
                    style={{
                      background: selectedAgent?.id === agent.id ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                      borderColor: selectedAgent?.id === agent.id ? 'var(--accent-primary)' : 'var(--border-subtle)'
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">{agent.emoji || '🤖'}</span>
                      <h3 className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{agent.name}</h3>
                      {agent.status === 'online' && (
                        <span className="w-1.5 h-1.5 rounded-full ml-auto shrink-0 status-online" />
                      )}
                    </div>
                    <p className="text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                      {agent.description}
                    </p>
                    {agent.capabilities && agent.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-0.5 mt-1.5">
                        {agent.capabilities.slice(0, 2).map((cap) => (
                          <span
                            key={cap}
                            className="text-[10px] px-1 py-0.5 rounded"
                            style={{ background: 'var(--accent-glow)', color: 'var(--accent-primary)' }}
                          >
                            {cap}
                          </span>
                        ))}
                        {agent.capabilities.length > 2 && (
                          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                            +{agent.capabilities.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              
              {/* 右侧详情 */}
              {selectedAgent && (
                <div className="w-72 border-l pl-4 overflow-auto shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="sticky top-0">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg"
                        style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))' }}
                      >
                        {selectedAgent.emoji || '🤖'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold truncate" style={{ color: 'var(--text-primary)' }}>{selectedAgent.name}</h3>
                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          <span>v{selectedAgent.version || '1.0.0'}</span>
                          {selectedAgent.status === 'online' && (
                            <span className="flex items-center gap-1" style={{ color: 'var(--success)' }}>
                              <span className="w-1.5 h-1.5 rounded-full status-online" />
                              在线
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="space-y-3 text-sm">
                      <div>
                        <label className="text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>描述</label>
                        <p className="mt-0.5" style={{ color: 'var(--text-primary)' }}>{selectedAgent.description}</p>
                      </div>
                      
                      {selectedAgent.capabilities && selectedAgent.capabilities.length > 0 && (
                        <div>
                          <label className="text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>能力</label>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {selectedAgent.capabilities.map((cap) => (
                              <span
                                key={cap}
                                className="text-xs px-2 py-0.5 rounded"
                                style={{ background: 'var(--accent-glow)', color: 'var(--accent-primary)' }}
                              >
                                {cap}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {selectedAgent.endpoint && (
                        <div>
                          <label className="text-xs font-medium uppercase" style={{ color: 'var(--text-tertiary)' }}>端点</label>
                          <div className="text-xs mt-0.5 font-mono px-2 py-1 rounded truncate"
                            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                          >
                            {selectedAgent.endpoint}
                          </div>
                        </div>
                      )}
                      
                      <div className="pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Agent 是工作流步骤的执行单元
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="p-4 border-t flex justify-between items-center" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            共 {agents.length} 个 Agent
          </span>
          <button onClick={onClose} className="btn btn-secondary">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
