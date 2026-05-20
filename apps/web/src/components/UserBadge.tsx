/**
 * 用户信息徽章 - User Badge
 * SEC-001: 用户认证系统
 */

import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { LoginModal } from './LoginModal';

export function UserBadge() {
  const [showLoginModal, setShowLoginModal] = useState(false);

  const { user, isAuthenticated, isAdmin, isGuest, logout, getRole, init } = useAuthStore();

  // 初始化（尝试恢复 session）
  useState(() => {
    init();
  });

  const avatarText = user?.name?.charAt(0) || user?.email?.charAt(0) || 'G';

  const roleLabel = {
    Guest: '访客',
    User: '用户',
    Admin: '管理员',
  }[getRole()] || '访客';

  const roleColor = {
    Guest: 'bg-gray-100 text-gray-600',
    User: 'bg-blue-100 text-blue-700',
    Admin: 'bg-amber-100 text-amber-700',
  }[getRole()] || 'bg-gray-100 text-gray-600';

  // 没有用户时显示登录按钮
  if (!user) {
    return (
      <>
        <button
          onClick={() => setShowLoginModal(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          登录
        </button>
        <LoginModal
          open={showLoginModal}
          onClose={() => setShowLoginModal(false)}
          onSuccess={() => setShowLoginModal(false)}
        />
      </>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {/* 用户信息 */}
      <div className="flex items-center gap-2">
        {/* 头像 */}
        <div 
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
            isAuthenticated() ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-600'
          }`}
        >
          {avatarText}
        </div>

        {/* 名称 + 角色 */}
        <div className="text-sm">
          <div className="font-medium text-gray-900">
            {user.name || user.email || '访客'}
          </div>
          <div className={`text-xs ${roleColor} px-1.5 py-0.5 rounded inline-block`}>
            {roleLabel}
          </div>
        </div>
      </div>

      {/* 登出按钮（已登录时显示）*/}
      {isAuthenticated() && (
        <button
          onClick={logout}
          className="p-2 text-gray-400 hover:text-gray-600 rounded"
          title="登出"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth="2" 
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" 
            />
          </svg>
        </button>
      )}

      {/* 登录按钮（访客时显示）*/}
      {isGuest() && (
        <button
          onClick={() => setShowLoginModal(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          登录
        </button>
      )}

      {/* 登录弹窗 */}
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={() => setShowLoginModal(false)}
      />
    </div>
  );
}