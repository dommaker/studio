/**
 * AC-2.2: studio 角色 provider=null 弹框提醒
 *
 * 检测到 studio 角色 provider 未配置时弹框，用户选 provider 后 PATCH 更新。
 * 用户关闭后 sessionStorage 标记，本次会话不再弹。
 */
import { useState, useEffect } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';

export interface StudioRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (provider: string) => void;
}

const SESSION_KEY = 'studio-role-setup-dismissed';

export function StudioRoleSetupModal({ open, onClose, onSave }: StudioRoleSetupModalProps) {
  const [selected, setSelected] = useState<string>('');
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders();
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // open 时重置；选项就绪后默认选中第一个可用 CLI
  useEffect(() => {
    if (!open) return;
    setSelected((prev) => {
      if (prev && providerOptions.some((o) => o.value === prev && !o.disabled)) return prev;
      return providerOptions.find((o) => !o.disabled)?.value ?? '';
    });
  }, [open, providerOptions]);

  if (!open) return null;

  const handleSave = () => {
    if (!selected) return;
    onSave(selected);
    onClose();
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* sessionStorage 不可用 */ }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleDismiss} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ background: 'white', padding: '24px', borderRadius: '8px', minWidth: '320px' }}>
        <h2 style={{ marginTop: 0 }}>系统执行角色未配置</h2>
        <p style={{ color: '#666', fontSize: '14px' }}>
          系统内部任务（知识维护、诊断、提取等）需要选择一个 CLI 作为执行角色。
        </p>
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="studio-provider-select" style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>选择 CLI</label>
          <select
            id="studio-provider-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
            data-testid="studio-provider-select"
          >
            {providerOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </select>
          {noneDetected && (
            <p style={{ color: '#999', fontSize: '13px', margin: '6px 0 0' }}>
              未在服务器上检测到已安装的 CLI，请确认安装后再选择。
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={handleDismiss} style={{ padding: '8px 16px' }}>稍后</button>
          <button onClick={handleSave} disabled={!selected} style={{ padding: '8px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '4px' }} data-testid="studio-provider-save">
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

/** 检查本次会话是否已dismiss */
export function isStudioRoleSetupDismissed(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}
