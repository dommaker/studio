// 忘记密码页面 — 输入邮箱，发送重置链接
import { useState } from 'react';
import { authApi } from '../api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await authApi.forgotPassword(email);
      if (data.message) setSent(true);
    } catch (e) {
      setError(e.response?.data?.error || e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen u-text flex items-center justify-center px-4 u-page-bg">
      <div className="card p-6 w-full max-w-sm" style={{ borderRadius: 6, boxShadow: 'var(--shadow-lg)' }}>
        <h1 className="text-lg font-bold mb-1">重置密码</h1>
        <p className="text-xs u-text-3 mb-4">输入注册邮箱，我们将发送重置链接</p>

        {sent ? (
          <div>
            <p className="u-ok text-sm mb-4">如果该邮箱已注册，重置密码链接已发送</p>
            <a
              href="/login"
              className="btn btn-secondary w-full"
            >
              返回登录
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              placeholder="your@email.com"
              autoFocus
              className="input w-full mb-3"
            />
            {error && <p className="u-err text-xs mb-3">{error}</p>}
            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="btn btn-primary w-full mb-2"
            >
              {loading ? '发送中...' : '发送重置链接'}
            </button>
            <a
              href="/login"
              className="block w-full text-center text-xs u-text-2 u-hover-text transition-colors"
            >
              返回登录
            </a>
          </form>
        )}
      </div>
    </div>
  );
}
