/**
 * 删除确认弹窗 - Delete Confirm Modal
 * SEC-005: 删除操作二次确认
 *
 * 用户必须输入资源 ID/名称才能确认删除，防止误删
 */

import { useState } from 'react';

interface DeleteConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** 资源类型，如 "角色"、"项目" */
  resourceType: string;
  /** 资源 ID/名称，用户需要输入这个来确认 */
  resourceId: string;
  /** 资源显示名称（可选） */
  resourceName?: string;
  /** 额外警告信息 */
  warningMessage?: string;
}

export function DeleteConfirmModal({
  open,
  onClose,
  onConfirm,
  resourceType,
  resourceId,
  resourceName,
  warningMessage,
}: DeleteConfirmModalProps) {
  const [confirmInput, setConfirmInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const displayId = resourceName || resourceId;
  const isMatch = confirmInput.trim() === resourceId || confirmInput.trim() === resourceName;

  const handleConfirm = async () => {
    if (!isMatch) {
      setError(`输入不匹配，请输入 "${displayId}"`);
      return;
    }

    setIsDeleting(true);
    setError('');

    try {
      await onConfirm();
      onClose();
    } catch (e: any) {
      setError(e.message || '删除失败');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleClose = () => {
    if (!isDeleting) {
      setConfirmInput('');
      setError('');
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      {/* Modal（modal-overlay 内置遮罩，点遮罩关闭；点内容不冒泡） */}
      <div className="modal" style={{ maxWidth: '28rem' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center u-err-dim">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="modal-title">
              删除 {resourceType}
            </h3>
          </div>
        </div>

        <div className="modal-body">
          {/* Warning */}
          <div className="mb-4 p-3 rounded-lg border u-err-dim u-err-border">
            <p className="text-sm font-medium">
              ⚠️ 此操作不可撤销
            </p>
            {warningMessage && (
              <p className="text-sm mt-1" style={{ opacity: 0.8 }}>
                {warningMessage}
              </p>
            )}
          </div>

          {/* Resource Info */}
          <div className="mb-4">
            <p className="text-sm mb-2 u-text-2">
              您即将删除：
            </p>
            <div className="p-2 rounded font-mono text-sm u-surface-2">
              {resourceType}: <span className="font-semibold">{displayId}</span>
            </div>
          </div>

          {/* Confirmation Input */}
          <div>
            <label className="block text-sm font-medium mb-2 u-text-2">
              请输入 "{displayId}" 以确认删除：
            </label>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => {
                setConfirmInput(e.target.value);
                setError('');
              }}
              className="input w-full"
              style={{ borderColor: error ? 'var(--error)' : undefined }}
              placeholder={displayId}
              disabled={isDeleting}
              autoFocus
            />
            {error && (
              <p className="text-sm mt-1 u-err">{error}</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="modal-footer">
          <button
            onClick={handleClose}
            disabled={isDeleting}
            className="btn btn-secondary"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isMatch || isDeleting}
            className="btn btn-danger"
          >
            {isDeleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}