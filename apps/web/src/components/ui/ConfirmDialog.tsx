// ConfirmDialog — 确认/警示弹窗：替代原生 window.confirm / alert
// 结构复用 ui/Modal（theme.css modal-* 类），按钮走 ui/Button（.btn 类体系）；
// danger 时确认键用 .btn-danger；cancelLabel={null} 退化为单按钮 alert 模式（纯告知场景）；
// loading 期间双键禁用、确认键出 spinner，且屏蔽遮罩点击关闭，防止重复提交。
import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  /** 标题（默认「确认」） */
  title?: ReactNode;
  /** 正文 */
  message: ReactNode;
  /** 确认键文案（默认「确认」） */
  confirmLabel?: string;
  /** 取消键文案（默认「取消」）；传 null → 单按钮 alert 模式 */
  cancelLabel?: string | null;
  /** 危险操作：确认键用 .btn-danger */
  danger?: boolean;
  /** 确认执行中：双键禁用 + 确认键 spinner，屏蔽遮罩关闭 */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title = '确认',
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={loading ? undefined : onCancel}
      title={title}
      maxWidth="420px"
      footer={
        <>
          {cancelLabel != null && (
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </Button>
          )}
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </div>
    </Modal>
  );
}
