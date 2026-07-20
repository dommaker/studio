/**
 * 删除按钮 - Delete Button
 * SEC-001: 用户认证系统
 * SEC-005: 删除操作二次确认
 */

import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { LoginModal } from './LoginModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';

interface DeleteButtonProps {
  deleteUrl: string;
  /** 资源类型，如 "角色"、"项目" */
  resourceType?: string;
  /** 资源 ID（用于确认） */
  resourceId?: string;
  /** 资源显示名称（可选，优先用于确认） */
  resourceName?: string;
  /** 额外警告信息 */
  warningMessage?: string;
  variant?: 'icon' | 'text' | 'button';
  disabled?: boolean;
  title?: string;
  children?: React.ReactNode;
  onSuccess?: () => void;
  onError?: (message: string) => void;
}

export function DeleteButton({
  deleteUrl,
  resourceType = '资源',
  resourceId,
  resourceName,
  warningMessage,
  variant = 'icon',
  disabled = false,
  title = '删除',
  children,
  onSuccess,
  onError,
}: DeleteButtonProps) {
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { isGuest, getAuthHeader } = useAuthStore();

  const buttonClass = {
    icon: 'p-1 u-text-3 u-hover-accent rounded u-hover-bg disabled:opacity-50',
    text: 'px-3 py-1 text-sm u-err u-hover-bg rounded disabled:opacity-50',
    button: 'px-4 py-2 u-err-bg u-on-accent rounded u-hover-bg disabled:opacity-50',
  }[variant];

  const handleClick = () => {
    // 检查是否登录
    if (isGuest()) {
      setShowLoginModal(true);
      return;
    }

    // 打开确认弹窗
    setShowConfirmModal(true);
  };

  const handleLoginSuccess = () => {
    setShowLoginModal(false);
    setShowConfirmModal(true);
  };

  const handleConfirmDelete = async () => {
    setIsLoading(true);

    try {
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          ...getAuthHeader(),
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const data = await response.json();

        // 401 = 未登录
        if (response.status === 401) {
          setShowConfirmModal(false);
          setShowLoginModal(true);
          return;
        }

        // 403 = 权限不足
        if (response.status === 403) {
          throw new Error(data.error || '权限不足，无法删除');
        }

        throw new Error(data.error || '删除失败');
      }

      onSuccess?.();
    } catch (e: any) {
      throw new Error(e.message || '删除失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 从 URL 提取 resourceId（如果未提供）
  const extractedId = resourceId || deleteUrl.split('/').pop() || '';

  return (
    <>
      <button
        onClick={handleClick}
        disabled={disabled || isLoading}
        className={buttonClass}
        title={title}
      >
        {isLoading ? (
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle 
              className="opacity-25" 
              cx="12" cy="12" r="10" 
              stroke="currentColor" 
              strokeWidth="4" 
              fill="none" 
            />
            <path 
              className="opacity-75" 
              fill="currentColor" 
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" 
            />
          </svg>
        ) : children || (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth="2" 
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" 
            />
          </svg>
        )}
      </button>

      {/* 登录弹窗 */}
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={handleLoginSuccess}
      />

      {/* 删除确认弹窗 */}
      <DeleteConfirmModal
        open={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={handleConfirmDelete}
        resourceType={resourceType}
        resourceId={extractedId}
        resourceName={resourceName}
        warningMessage={warningMessage}
      />
    </>
  );
}