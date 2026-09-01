// 重置密码页面 — 使用 token 设置新密码
import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { authApi } from '../api';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) { setError('重置链接无效'); return; }
    if (password.length < 6) { setError('密码至少6位'); return; }
    if (password !== confirm) { setError('两次密码不一致'); return; }

    setLoading(true);
    setError('');
    try {
      const { data } = await authApi.resetPassword(token, password);
      if (data.message) setSuccess(true);
    } catch (e) {
      setError(e.response?.data?.error || e.message || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen u-text flex items-center justify-center px-4 u-page-bg">
        <div className="card p-6 w-full max-w-sm text-center" style={{ borderRadius: 6, boxShadow: 'var(--shadow-lg)' }}>
          <p className="u-err text-sm mb-4">重置链接无效</p>
          <a href="/forgot-password" className="text-xs u-text-2 u-hover-text">重新发送重置链接</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen u-text flex items-center justify-center px-4 u-page-bg">
      <div className="card p-6 w-full max-w-sm" style={{ borderRadius: 6, boxShadow: 'var(--shadow-lg)' }}>
        <h1 className="text-lg font-bold mb-4">设置新密码</h1>

        {success ? (
          <div>
            <p className="u-ok text-sm mb-4">密码重置成功，请使用新密码登录</p>
            <button
              onClick={() => navigate('/login')}
              className="btn btn-secondary w-full"
            >
              前往登录
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder="新密码"
              autoFocus
              className="input w-full mb-2"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setError(''); }}
              placeholder="确认新密码"
              className="input w-full mb-3"
            />
            {error && <p className="u-err text-xs mb-3">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password.trim() || !confirm.trim()}
              className="btn btn-primary w-full"
            >
              {loading ? '重置中...' : '重置密码'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
