/**
 * AC-2.3（F2，2026-07-28）: 无已配置 provider 的用户角色时弹框提醒
 *
 * 检测到不存在任何 provider 非空的 active 角色（不含 studio）时弹框——
 * 角色存在但 provider 为空 = 没有可用执行体，与"没有角色"同样需要引导。
 * 用户填 name/description/provider 创建第一个角色。关闭后 sessionStorage 标记。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { FIRST_ROLE_SETUP_SESSION_KEY } from './dismissed';
import { Select } from '../ui';
import '../../styles/theme.css';

export interface FirstRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description?: string; provider?: string }) => void;
}

export function FirstRoleSetupModal({ open, onClose, onCreate }: FirstRoleSetupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 用户显式选择的 CLI；空 = 未选过（或选择已失效），由下方派生值回退默认
  const [providerOverride, setProviderOverride] = useState<string>('');
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders();
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // 生效的 provider 为渲染期纯派生（替代原 effect 同步回填）：显式选择仍有效则用选择，
  // 否则回退第一个可用 CLI——选项异步晚到自动回填、选择失效自动回退的语义不变
  const provider = providerOverride && providerOptions.some((o) => o.value === providerOverride && !o.disabled)
    ? providerOverride
    : providerOptions.find((o) => !o.disabled)?.value ?? '';

  // 弹窗打开时在渲染期同步重置表单（prevOpen 上升沿，替代原 effect 同步重置）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName('');
      setDescription('');
    }
  }

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
    try { sessionStorage.setItem(FIRST_ROLE_SETUP_SESSION_KEY, '1'); } catch { /* ignore */ }
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
            <Select
              id="first-role-provider"
              className="input"
              value={provider}
              onChange={setProviderOverride}
              options={providerOptions}
              style={{ width: '100%' }}
              data-testid="first-role-provider"
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
