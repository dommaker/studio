// WorkflowConfigPanel.tsx - Workflow 配置面板组件（深色主题）
import { useState, useEffect } from 'react';
import type { Node } from '@xyflow/react';
import { useWorkflowEditorStore } from '../stores/workflowEditorStore';
import { toast } from '../utils/toast';

interface WorkflowConfigPanelProps {
  selectedNode: Node | null;
  onUpdateNode: (nodeId: string, data: Partial<Node['data']>) => void;
}

export function WorkflowConfigPanel({ selectedNode, onUpdateNode }: WorkflowConfigPanelProps) {
  const { workflow } = useWorkflowEditorStore();
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // 从 workflow 数据初始化表单
  useEffect(() => {
    if (workflow) {
      setWorkflowName(workflow.name || '');
      setWorkflowDescription(workflow.description || '');
    }
  }, [workflow]);

  const getNodeLabel = (): string => {
    if (!selectedNode?.data?.label) return '';
    const label = selectedNode.data.label;
    return typeof label === 'string' ? label : String(label);
  };

  const getStepData = () => {
    if (!selectedNode?.data?.step) return null;
    return selectedNode.data.step as { id: string; name: string; description?: string; agent?: string; };
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      console.log('保存工作流:', { name: workflowName, description: workflowDescription });
      await new Promise(resolve => setTimeout(resolve, 1000));
      toast.success('保存成功！');
    } catch (error) {
      toast.error('保存失败：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const stepData = getStepData();

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>配置面板</h3>
      
      {/* 工作流信息 */}
      <div className="mb-6 p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2 mb-2">
          {workflow?.openclaw?.emoji && <span className="text-xl">{workflow.openclaw.emoji}</span>}
          <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
            {workflow?.name || '新建工作流'}
          </div>
        </div>
        {workflow?.id && (
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            ID: {workflow.id}
          </div>
        )}
        {workflow?.description && (
          <div className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
            {workflow.description}
          </div>
        )}
        {workflow?.steps && (
          <div className="text-xs mt-2" style={{ color: 'var(--text-tertiary)' }}>
            {workflow.steps.length} 个步骤
          </div>
        )}
      </div>
      
      {selectedNode ? (
        <div className="mb-6">
          <div className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>🔧 节点配置</div>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>节点名称</label>
              <input
                type="text"
                value={getNodeLabel()}
                onChange={(e) => onUpdateNode(selectedNode.id, { label: e.target.value })}
                className="input w-full"
                placeholder="输入节点名称"
              />
            </div>
            
            {stepData && (
              <div className="p-3 rounded-lg" style={{ background: 'rgba(0, 212, 255, 0.08)' }}>
                <div className="text-sm font-medium" style={{ color: 'var(--accent-primary)' }}>{stepData.name}</div>
                {stepData.description && <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{stepData.description}</div>}
                {stepData.agent && <div className="text-xs mt-1" style={{ color: 'var(--accent-primary)' }}>{stepData.agent === 'codex' ? '🤖 Codex' : '🧠 Claude'}</div>}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-6 p-4 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
          <p className="mb-2">👆 点击节点查看配置</p>
          <p className="mb-2">🖱️ 从左侧点击步骤添加到画布</p>
          <p className="mb-2">🔗 连接节点创建流程</p>
        </div>
      )}
      
      <div className="pt-6" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>编辑工作流信息</h4>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>工作流名称 *</label>
            <input type="text" value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} className="input w-full" placeholder="输入工作流名称" />
          </div>
          
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>工作流描述</label>
            <textarea value={workflowDescription} onChange={(e) => setWorkflowDescription(e.target.value)} className="input w-full" placeholder="输入工作流描述" rows={6} style={{ minHeight: '120px' }} />
          </div>
        </div>
        
        <div className="mt-6 flex gap-2">
          <button onClick={handleSave} disabled={saving || !workflowName} className="btn btn-primary flex-1">{saving ? '保存中...' : '保存'}</button>
          <button className="btn btn-ghost flex-1">取消</button>
        </div>
      </div>
    </div>
  );
}

export default WorkflowConfigPanel;
