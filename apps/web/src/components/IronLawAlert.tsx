/**
 * 铁律提示组件
 * 
 * 在用户执行关键操作时，显示铁律提示
 */

import React from 'react';

export interface IronLaw {
  id: string;
  rule: string;
  message: string;
  trigger: string;
  enforcement: string;
  severity: 'error' | 'warning' | 'info';
  description?: string;
}

export interface IronLawAlertProps {
  law: IronLaw;
  onConfirm?: () => void;
  onCancel?: () => void;
  visible?: boolean;
}

export const IronLawAlert: React.FC<IronLawAlertProps> = ({
  law,
  onConfirm,
  onCancel,
  visible = true,
}) => {
  if (!visible) return null;

  const severityConfig = {
    error: { bg: 'rgba(239,68,68,0.1)', border: '#ef4444', text: 'var(--error)' },
    warning: { bg: 'rgba(234,179,8,0.1)', border: '#eab308', text: '#b45309' },
    info: { bg: 'rgba(59,130,246,0.1)', border: '#3b82f6', text: 'var(--accent-primary)' },
  };

  const severityIcons = {
    error: '🚫',
    warning: '⚠️',
    info: 'ℹ️',
  };

  const sev = severityConfig[law.severity];

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '28rem', borderLeft: `4px solid ${sev.border}` }}>
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">{severityIcons[law.severity]}</span>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>铁律提示</h3>
          </div>

          {/* Rule */}
          <div className="mb-4">
            <p className="font-mono text-sm p-2 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
              {law.rule}
            </p>
          </div>

          {/* Message */}
          <div className="mb-4">
            <p style={{ color: 'var(--text-secondary)' }}>{law.message}</p>
          </div>

          {/* Description */}
          {law.description && (
            <div className="mb-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              <p>{law.description}</p>
            </div>
          )}

          {/* Suggested Action */}
          <div className="mb-6 p-3 rounded" style={{ background: sev.bg }}>
            <p className="text-sm" style={{ color: sev.text }}>
              <span className="font-semibold">建议操作：</span>
              {law.enforcement}
            </p>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={onCancel}
              className="btn btn-secondary"
            >
              取消
            </button>
            <button
              onClick={onConfirm}
              className="btn btn-primary"
            >
              执行建议操作
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default IronLawAlert;
