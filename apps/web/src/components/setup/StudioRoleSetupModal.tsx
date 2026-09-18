/**
 * AC-2.2: studio 角色 provider=null 弹框提醒
 *
 * 检测到 studio 角色 provider 未配置时弹框，用户选 provider 后 PATCH 更新。
 * 用户关闭后 sessionStorage 标记，本次会话不再弹。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { STUDIO_ROLE_SETUP_SESSION_KEY } from './dismissed';
import { Select, Modal } from '../ui';

export interface StudioRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (provider: string) => void;
}

export function StudioRoleSetupModal({ open, onClose, onSave }: StudioRoleSetupModalProps) {
  // 用户显式选择的 CLI；空 = 未选过（或选择已失效），由下方派生值回退默认
  const [selectedOverride, setSelectedOverride] = useState<string>('');
  // #448 问题3：弹框关着不扫运行环境（App 根无条件挂载本组件，enabled=false 时才不发请求）
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders({ enabled: open });
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // 生效的选中项为渲染期纯派生（替代原 effect 同步回填）：显式选择仍有效则用选择，
  // 否则回退第一个可用 CLI——open 后选项异步晚到自动回填的语义不变
  const selected = selectedOverride && providerOptions.some((o) => o.value === selectedOverride && !o.disabled)
    ? selectedOverride
    : providerOptions.find((o) => !o.disabled)?.value ?? '';

  if (!open) return null;

  const handleSave = () => {
    if (!selected) return;
    onSave(selected);
    onClose();
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem(STUDIO_ROLE_SETUP_SESSION_KEY, '1'); } catch { /* sessionStorage 不可用 */ }
    onClose();
  };

  // 批次 I-2：收编 ui/Modal（§4.3 正本）；onClose=handleDismiss（关窗即 sessionStorage 标记）
  return (
    <Modal
      onClose={handleDismiss}
      maxWidth="400px"
      title="系统执行角色未配置"
      footer={
        <>
          <button className="btn btn-secondary" onClick={handleDismiss}>稍后</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!selected}
            data-testid="studio-provider-save"
          >
            确认
          </button>
        </>
      }
    >
          <p className="u-text-2" style={{ margin: '0 0 12px', fontSize: 'var(--fs-sm)' }}>
            系统内部任务（知识维护、诊断、提取等）需要选择一个 CLI 作为执行角色。
          </p>
          <div>
            <label htmlFor="studio-provider-select" className="form-label">选择 CLI</label>
            <Select
              id="studio-provider-select"
              className="input"
              value={selected}
              onChange={setSelectedOverride}
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
    </Modal>
  );
}
