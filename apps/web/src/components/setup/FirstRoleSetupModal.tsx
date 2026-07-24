/**
 * AC-2.3: 无用户角色时弹框提醒
 *
 * 检测到无任何用户角色（不含 studio）时弹框，用户填 name/description/provider
 * 创建第一个角色。关闭后 sessionStorage 标记。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState, useEffect } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import '../../styles/theme.css';

export interface FirstRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description?: string; provider?: string }) => void;
}

const SESSION_KEY = 'first-role-setup-dismissed';

export function FirstRoleSetupModal({ open, onClose, onCreate }: FirstRoleSetupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<string>('');
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders();
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);

  // 选项就绪后默认选中第一个可用 CLI；当前选中项失效时同样回退
  useEffect(() => {
    if (!open) return;
    if (provider && providerOptions.some((o) => o.value === provider && !o.disabled)) return;
    const first = providerOptions.find((o) => !o.disabled);
    if (first) setProvider(first.value);
  }, [open, providerOptions, provider]);

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
    <div className="modal-overlay" onClick={handleDismiss}>
      <div className="modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">请创建角色</h2>
          <button className="modal-close" onClick={handleDismiss} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="u-text-2" style={{ margin: '0 0 12px', fontSize: 'var(--fs-sm)' }}>
            Agent Network 需要至少一个角色才能接收任务。请创建你的第一个角色。
          </p>
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="first-role-name" className="u-text" style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--fs-sm)', fontWeight: 500 }}>名称</label>
            <input
              id="first-role-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 dev-agent、reviewer"
              style={{ width: '100%' }}
              data-testid="first-role-name"
              autoFocus
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="first-role-desc" className="u-text" style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--fs-sm)', fontWeight: 500 }}>描述（可选）</label>
            <input
              id="first-role-desc"
              type="text"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="角色职责说明"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label htmlFor="first-role-provider" className="u-text" style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--fs-sm)', fontWeight: 500 }}>CLI</label>
            <select
              id="first-role-provider"
              className="input"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              style={{ width: '100%' }}
              data-testid="first-role-provider"
            >
              {providerOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
              ))}
            </select>
            {noneDetected && (
              <p className="u-text-2" style={{ margin: '6px 0 0', fontSize: 'var(--fs-sm)' }}>
                未在服务器上检测到已安装的 CLI，请确认安装后再选择。
              </p>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleDismiss}>稍后</button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!name.trim() || !provider}
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
