/**
 * 登录弹窗 - Login Modal
 * SEC-001: 用户认证系统
 */

import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function LoginModal({ open, onClose, onSuccess }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isRegister, setIsRegister] = useState(false);

  const { login, register, isLoading, error, setError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    let success = false;
    if (isRegister) {
      success = await register(email, password, name);
    } else {
      success = await login(email, password);
    }

    if (success) {
      onSuccess?.();
      handleClose();
    }
  };

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setName('');
    setError(null);
    setIsRegister(false);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      {/* Modal */}
      <div className="modal" style={{ maxWidth: '28rem', width: '100%' }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" style={{ marginBottom: '16px' }}>
          {isRegister ? '注册账号' : '登录'}
        </h2>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 p-3 rounded-lg text-sm" style={{ background: 'var(--error-dim)', color: 'var(--error)' }}>
            {error}
          </div>
        )}

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 邮箱 */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              邮箱
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input w-full"
              placeholder="your@email.com"
            />
          </div>

          {/* 密码 */}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="input w-full"
              placeholder="至少 6 位"
            />
          </div>

          {/* 姓名（注册时显示）*/}
          {isRegister && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                姓名（可选）
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input w-full"
                placeholder="你的名字"
              />
            </div>
          )}

          {/* 提交按钮 */}
          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full"
          >
            {isLoading ? '处理中...' : isRegister ? '注册' : '登录'}
          </button>
        </form>

        {/* 切换登录/注册 */}
        <div className="mt-4 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {isRegister ? (
            <>
              已有账号？
              <button
                onClick={() => setIsRegister(false)}
                className="hover:underline ml-1"
                style={{ color: 'var(--accent-primary)' }}
              >
                登录
              </button>
            </>
          ) : (
            <>
              没有账号？
              <button
                onClick={() => setIsRegister(true)}
                className="hover:underline ml-1"
                style={{ color: 'var(--accent-primary)' }}
              >
                注册
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}