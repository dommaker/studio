// ConfigPanel.tsx - 配置面板组件（深色主题）
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Node } from '@xyflow/react';
import { useStepEditorStore } from '../stores/stepEditorStore';
import { toast } from '../utils/toast';

interface ConfigPanelProps {
  selectedNode: Node | null;
  onUpdateNode: (nodeId: string, data: Partial<Node['data']>) => void;
}

export function ConfigPanel({ selectedNode, onUpdateNode }: ConfigPanelProps) {
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id || id === 'new';
  
  const { step, saving, saveError, saveStep, nodes } = useStepEditorStore();
  
  const [stepName, setStepName] = useState('');
  const [stepDescription, setStepDescription] = useState('');
  const [stepCategory, setStepCategory] = useState('custom');
  const [agentType, setAgentType] = useState<'codex' | 'claude'>('codex');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (step) {
      setStepName(step.name || '');
      setStepDescription(step.description || '');
      setStepCategory(step.category || 'custom');
      setAgentType(step.agent || 'codex');
    }
  }, [step]);

  const handleLabelChange = (label: string) => {
    if (selectedNode) onUpdateNode(selectedNode.id, { label });
  };

  const getNodeLabel = (): string => {
    if (!selectedNode?.data?.label) return '';
    return typeof selectedNode.data.label === 'string' ? selectedNode.data.label : String(selectedNode.data.label);
  };

  const getToolData = () => {
    if (!selectedNode?.data?.tool) return null;
    return selectedNode.data.tool as { id: string; name: string; description?: string; };
  };

  const validateForm = (): string | null => {
    if (!stepName.trim()) return '请输入步骤名称';
    if (nodes.length === 0) return '请至少添加一个工具节点';
    return null;
  };

  const handleSave = async () => {
    setLocalError(null);
    const validationError = validateForm();
    if (validationError) { setLocalError(validationError); return; }
    
    try {
      const result = await saveStep({ name: stepName.trim(), description: stepDescription.trim(), category: stepCategory, agent: agentType });
      if (result.success) {
        toast.success(isNew ? '步骤创建成功！' : '步骤更新成功！');
        navigate('/steps');
      } else {
        setLocalError(result.error || '保存失败');
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '保存失败');
    }
  };

  const toolData = getToolData();
  const error = localError || saveError;

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>配置面板</h3>
      
      {error && (
        <div className="mb-4 p-3 rounded-lg text-sm" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: 'var(--error)' }}>❌ {error}</div>
      )}
      
      {selectedNode ? (
        <div className="mb-6">
          <div className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>🔧 节点配置</div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>节点名称</label>
              <input type="text" value={getNodeLabel()} onChange={(e) => handleLabelChange(e.target.value)} className="input w-full" placeholder="输入节点名称" />
            </div>
            
            {toolData && (
              <div className="p-3 rounded-lg" style={{ background: 'rgba(0, 212, 255, 0.08)' }}>
                <div className="text-sm font-medium" style={{ color: 'var(--accent-primary)' }}>{toolData.name}</div>
                {toolData.description && <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{toolData.description}</div>}
              </div>
            )}
            
            <div>
              <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>节点 ID</label>
              <div className="px-3 py-2 rounded-md text-sm font-mono" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>{selectedNode.id}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6 p-4 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
          <p className="mb-2">👆 点击节点查看配置</p>
          <p className="mb-2">🖱️ 从左侧拖拽工具到画布</p>
          <p className="mb-2">🔗 连接节点创建流程</p>
        </div>
      )}
      
      <div className="pt-6" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>步骤信息</h4>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>步骤名称 *</label>
            <input type="text" value={stepName} onChange={(e) => setStepName(e.target.value)} className="input w-full" placeholder="输入步骤名称" />
          </div>
          
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>步骤描述</label>
            <textarea value={stepDescription} onChange={(e) => setStepDescription(e.target.value)} className="input w-full" placeholder="输入步骤描述" rows={3} />
          </div>
          
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>分类</label>
            <select value={stepCategory} onChange={(e) => setStepCategory(e.target.value)} className="input w-full">
              <option value="custom">自定义</option>
              <option value="analysis">分析</option>
              <option value="design">设计</option>
              <option value="development">开发</option>
              <option value="quality">质量</option>
              <option value="deploy">部署</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>Agent 类型</label>
            <select value={agentType} onChange={(e) => setAgentType(e.target.value as 'codex' | 'claude')} className="input w-full">
              <option value="codex">Codex 🤖</option>
              <option value="claude">Claude 🧠</option>
            </select>
          </div>
          
          <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              已选工具：<span className="font-medium" style={{ color: 'var(--text-primary)' }}>{nodes.length}</span> 个
            </div>
          </div>
        </div>
        
        <div className="mt-6 flex gap-2">
          <button onClick={handleSave} disabled={saving || !stepName} className="btn btn-primary flex-1">{saving ? '保存中...' : (isNew ? '创建' : '保存')}</button>
          <button onClick={() => navigate('/steps')} className="btn btn-ghost flex-1">取消</button>
        </div>
      </div>
    </div>
  );
}

export default ConfigPanel;
