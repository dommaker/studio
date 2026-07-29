/**
 * AC-2.2: studio 角色 provider=null 弹框提醒
 *
 * 检测到 studio 角色 provider 未配置时弹框，用户选 provider 后 PATCH 更新。
 * 用户关闭后 sessionStorage 标记，本次会话不再弹。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState, useEffect } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { Select } from '../ui';
import '../../styles/theme.css';

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
    <div className="modal-overlay" onClick={handleDismiss}>
      <div className="modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">系统执行角色未配置</h2>
          <button className="modal-close" onClick={handleDismiss} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="u-text-2" style={{ margin: '0 0 12px', fontSize: 'var(--fs-sm)' }}>
            系统内部任务（知识维护、诊断、提取等）需要选择一个 CLI 作为执行角色。
          </p>
          <div>
            <label htmlFor="studio-provider-select" className="u-text" style={{ display: 'block', marginBottom: '4px', fontSize: 'var(--fs-sm)', fontWeight: 500 }}>选择 CLI</label>
            <Select
              id="studio-provider-select"
              className="input"
              value={selected}
              onChange={setSelected}
              options={providerOptions}
              style={{ width: '100%' }}
              data-testid="studio-provider-select"
            />
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
            onClick={handleSave}
            disabled={!selected}
            data-testid="studio-provider-save"
          >
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
