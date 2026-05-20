// 工作流启动弹窗
import { useState, useEffect } from 'react';
import { useRuntimeStore } from '../stores';
import { api } from '../api';

interface WorkflowInput {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  default?: any;
}

interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  inputs?: WorkflowInput[];
  openclaw?: {
    userInvocable?: boolean;
    emoji?: string;
    keywords?: string[];
  };
}

interface WorkflowStartModalProps {
  workflow: WorkflowInfo | null;
  onClose: () => void;
  onStarted?: (executionId: string) => void;
}

interface Role {
  id: string;
  name: string;
  type: string;
  description?: string;
}

export function WorkflowStartModal({ workflow, onClose, onStarted }: WorkflowStartModalProps) {
  const { executeRuntimeWorkflow } = useRuntimeStore();
  
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载角色列表
  useEffect(() => {
    async function loadRoles() {
      try {
        const response = await api.get('/roles?limit=20');
        setRoles(response.data.data || []);
      } catch (err) {
        console.error('Failed to load roles:', err);
      }
    }
    loadRoles();
  }, []);

  // 初始化输入参数
  useEffect(() => {
    if (workflow?.inputs) {
      const defaultInputs: Record<string, any> = {};
      workflow.inputs.forEach((input: WorkflowInput) => {
        if (input.default !== undefined) {
          defaultInputs[input.name] = input.default;
        }
      });
      setInputs(defaultInputs);
    }
  }, [workflow]);

  if (!workflow) return null;

  const handleToggleRole = (roleId: string) => {
    setSelectedRoles(prev => 
      prev.includes(roleId) 
        ? prev.filter(id => id !== roleId)
        : [...prev, roleId]
    );
  };

  const handleInputChange = (name: string, value: any) => {
    setInputs(prev => ({ ...prev, [name]: value }));
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // 验证必填参数
      const missingRequired = workflow.inputs?.filter(
        (input: WorkflowInput) => input.required && !inputs[input.name]
      );
      
      if (missingRequired && missingRequired.length > 0) {
        setError(`缺少必填参数: ${missingRequired.map((i: WorkflowInput) => i.name).join(', ')}`);
        setLoading(false);
        return;
      }

      // 执行工作流
      const execution = await executeRuntimeWorkflow(workflow.id, {
        ...inputs,
        _selectedRoles: selectedRoles, // 传递选中的角色
      });

      if (execution?.id) {
        onStarted?.(execution.id);
        onClose();
      }
    } catch (err: any) {
      console.error('Failed to start workflow:', err);
      setError(err.message || '启动失败');
    } finally {
      setLoading(false);
    }
  };

  const getRoleIcon = (type: string) => {
    const icons: Record<string, string> = {
      'developer': '👨‍💻',
      'architect': '🏗️',
      'tester': '🧪',
      'designer': '🎨',
      'product-manager': '📊',
      'analyst': '📈',
      'reviewer': '🔍',
      'default': '👤',
    };
    return icons[type] || icons.default;
  };

  return (
    <div className="modal-overlay animate-fadeIn" onClick={onClose}>
      <div 
        className="modal-content animate-scaleIn" 
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '600px', maxHeight: '80vh', overflow: 'auto' }}
      >
        <div className="modal-header">
          <h3 className="modal-title">
            {workflow.openclaw?.emoji || '🚀'} 启动工作流
          </h3>
          <button onClick={onClose} className="modal-close">✕</button>
        </div>

        <div className="space-y-4 p-4">
          {/* 工作流信息 */}
          <div className="p-3 rounded" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {workflow.name}
            </div>
            <div className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              {workflow.description?.split('\n')[0]}
            </div>
          </div>

          {/* 输入参数 */}
          {workflow.inputs && workflow.inputs.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                输入参数
              </div>
              <div className="space-y-3">
                {workflow.inputs.map((input: WorkflowInput) => (
                  <div key={input.name}>
                    <label className="block text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                      {input.description || input.name}
                      {input.required && <span style={{ color: 'var(--accent-danger)' }}> *</span>}
                    </label>
                    {input.type === 'boolean' ? (
                      <select
                        className="input-field w-full"
                        value={inputs[input.name] ?? false}
                        onChange={e => handleInputChange(input.name, e.target.value === 'true')}
                      >
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : input.type === 'number' ? (
                      <input
                        type="number"
                        className="input-field w-full"
                        value={inputs[input.name] ?? ''}
                        onChange={e => handleInputChange(input.name, Number(e.target.value))}
                        placeholder={input.description}
                      />
                    ) : (
                      <textarea
                        className="input-field w-full"
                        value={inputs[input.name] ?? ''}
                        onChange={e => handleInputChange(input.name, e.target.value)}
                        placeholder={input.description}
                        rows={input.name === 'requirement' ? 4 : 2}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 角色选择 */}
          <div>
            <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              参与角色（可选）
            </div>
            <div className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>
              选择参与此工作流的角色，他们将在各自的步骤中负责执行
            </div>
            
            {roles.length === 0 ? (
              <div className="text-sm p-3 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
                暂无可用角色，请先在「角色」页面创建角色
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {roles.map(role => (
                  <button
                    key={role.id}
                    onClick={() => handleToggleRole(role.id)}
                    className={`p-3 rounded-lg text-left transition-all ${
                      selectedRoles.includes(role.id) 
                        ? 'ring-2' 
                        : ''
                    }`}
                    style={{
                      background: selectedRoles.includes(role.id) 
                        ? 'var(--bg-hover)' 
                        : 'var(--bg-elevated)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{getRoleIcon(role.type)}</span>
                      <div>
                        <div className="text-sm font-medium">{role.name}</div>
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {role.type}
                        </div>
                      </div>
                      {selectedRoles.includes(role.id) && (
                        <span className="ml-auto" style={{ color: 'var(--accent-primary)' }}>✓</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            
            {selectedRoles.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                已选择 {selectedRoles.length} 个角色
              </div>
            )}
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded text-sm" style={{ background: 'var(--color-error-bg)', color: 'var(--color-error)' }}>
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button
              onClick={onClose}
              className="btn btn-secondary"
              disabled={loading}
            >
              取消
            </button>
            <button
              onClick={handleStart}
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? '启动中...' : '🚀 启动工作流'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
