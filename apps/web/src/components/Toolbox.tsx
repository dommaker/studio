// Toolbox.tsx - 工具箱组件（深色主题）
import { useEffect } from 'react';
import { useStepEditorStore, type Tool } from '../stores/stepEditorStore';

export function Toolbox() {
  const { tools, toolsLoading, toolsError, loadTools } = useStepEditorStore();

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const onDragStart = (event: React.DragEvent, tool: Tool) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify({ type: 'tool', tool }));
    event.dataTransfer.effectAllowed = 'move';
  };

  if (toolsLoading) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>工具箱</h3>
        <div className="flex items-center justify-center py-8">
          <div className="loading-spinner"></div>
        </div>
      </div>
    );
  }

  if (toolsError) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>工具箱</h3>
        <div className="card p-3" style={{ borderColor: 'rgba(239, 68, 68, 0.3)', color: 'var(--error)' }}>{toolsError}</div>
        <button onClick={loadTools} className="btn btn-primary w-full mt-3">重试</button>
      </div>
    );
  }

  if (tools.length === 0) {
    return (
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>工具箱</h3>
        <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>暂无可用工具</div>
      </div>
    );
  }

  const groupedTools = tools.reduce((acc, tool) => {
    const category = tool.category || '其他';
    if (!acc[category]) acc[category] = [];
    acc[category].push(tool);
    return acc;
  }, {} as Record<string, Tool[]>);

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>工具箱</h3>
      
      <div className="mb-4 p-3 rounded-lg text-xs" style={{ background: 'rgba(0, 212, 255, 0.08)', color: 'var(--accent-primary)' }}>
        💡 拖拽工具到画布添加节点
      </div>
      
      <div className="space-y-4">
        {Object.entries(groupedTools).map(([category, categoryTools]) => (
          <div key={category}>
            <div className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>{category}</div>
            <div className="space-y-2">
              {categoryTools.map((tool) => (
                <div
                  key={tool.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, tool)}
                  className="p-3 rounded-lg cursor-move transition-all"
                  style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{tool.name}</div>
                      <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{tool.description}</div>
                    </div>
                    <div className="ml-2" style={{ color: 'var(--text-muted)' }}>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
                      </svg>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Toolbox;
