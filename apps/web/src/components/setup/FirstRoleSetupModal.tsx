/**
 * AC-2.3: 无用户角色时弹框提醒
 *
 * 检测到无任何用户角色（不含 studio）时弹框，用户填 name/description/provider
 * 创建第一个角色。关闭后 sessionStorage 标记。
 */
import { useState, useEffect } from 'react';

export interface FirstRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description?: string; provider?: string }) => void;
}

const PROVIDERS = ['claude', 'kimi', 'codex', 'opencode'] as const;
const SESSION_KEY = 'first-role-setup-dismissed';

export function FirstRoleSetupModal({ open, onClose, onCreate }: FirstRoleSetupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<string>('claude');

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setProvider('claude');
    }
  }, [open]);

  if (!open) return null;

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      description: description.trim() || undefined,
      provider,
    });
    onClose();
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleDismiss} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ background: 'white', padding: '24px', borderRadius: '8px', minWidth: '360px' }}>
        <h2 style={{ marginTop: 0 }}>请创建角色</h2>
        <p style={{ color: '#666', fontSize: '14px' }}>
          Agent Network 需要至少一个角色才能接收任务。请创建你的第一个角色。
        </p>
        <div style={{ marginBottom: '12px' }}>
          <label htmlFor="first-role-name" style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>名称</label>
          <input
            id="first-role-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 dev-agent、reviewer"
            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
            data-testid="first-role-name"
            autoFocus
          />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label htmlFor="first-role-desc" style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>描述（可选）</label>
          <input
            id="first-role-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="角色职责说明"
            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="first-role-provider" style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>CLI</label>
          <select
            id="first-role-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
            data-testid="first-role-provider"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={handleDismiss} style={{ padding: '8px 16px' }}>稍后</button>
          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            style={{ padding: '8px 16px', background: name.trim() ? '#2563eb' : '#ccc', color: 'white', border: 'none', borderRadius: '4px' }}
            data-testid="first-role-create"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

export function isFirstRoleSetupDismissed(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}
