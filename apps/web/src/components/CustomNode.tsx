// CustomNode - 自定义深色主题节点
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

interface CustomNodeData {
  label: string;
  description?: string;
  icon?: string;
  status?: 'pending' | 'running' | 'success' | 'error';
  step?: any;
  tool?: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomNodeComponent({ data, selected }: any) {
  const nodeData = data as CustomNodeData;
  
  const statusColors: Record<string, string> = {
    pending: 'var(--text-tertiary)',
    running: 'var(--accent-primary)',
    success: 'var(--success)',
    error: 'var(--error)',
  };
  
  const statusColor = nodeData.status ? statusColors[nodeData.status] : 'var(--accent-primary)';

  return (
    <div
      style={{
        background: 'var(--bg-tertiary)',
        border: selected ? `2px solid var(--accent-primary)` : '2px solid rgba(0, 212, 255, 0.3)',
        borderRadius: '12px',
        padding: '12px 16px',
        minWidth: '120px',
        boxShadow: selected ? 'var(--shadow-glow)' : 'var(--shadow-md)',
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* 输入连接点 */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: 'var(--accent-primary)',
          border: '2px solid var(--bg-tertiary)',
          width: '12px',
          height: '12px',
        }}
      />
      
      {/* 节点内容 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
        {nodeData.icon && <span style={{ fontSize: '18px' }}>{nodeData.icon}</span>}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            color: 'var(--text-primary)',
            fontSize: '14px',
            fontWeight: 500,
          }}>
            {nodeData.label}
          </div>
          {nodeData.description && (
            <div style={{
              color: 'var(--text-tertiary)',
              fontSize: '12px',
              marginTop: '2px',
            }}>
              {nodeData.description}
            </div>
          )}
        </div>
      </div>
      
      {/* 状态指示器 */}
      {nodeData.status && (
        <div style={{
          position: 'absolute',
          top: '-4px',
          right: '-4px',
          width: '12px',
          height: '12px',
          borderRadius: '50%',
          background: statusColor,
          border: '2px solid var(--bg-tertiary)',
        }} />
      )}
      
      {/* 输出连接点 */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: 'var(--accent-primary)',
          border: '2px solid var(--bg-tertiary)',
          width: '12px',
          height: '12px',
        }}
      />
    </div>
  );
}

export const CustomNode = memo(CustomNodeComponent);
