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
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-white flex items-center justify-center px-4">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h1 className="text-lg font-bold mb-1">重置密码</h1>
        <p className="text-xs text-gray-400 mb-4">输入注册邮箱，我们将发送重置链接</p>

        {sent ? (
          <div>
            <p className="text-green-400 text-sm mb-4">如果该邮箱已注册，重置密码链接已发送</p>
            <a
              href="/login"
              className="block w-full text-center px-4 py-2.5 bg-gray-700 rounded-lg text-gray-200 text-sm hover:bg-gray-600 transition-colors"
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
              className="w-full px-4 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-gray-400 mb-3"
            />
            {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full px-4 py-2.5 bg-gray-700 rounded-lg text-gray-200 text-sm hover:bg-gray-600 disabled:opacity-50 transition-colors mb-2"
            >
              {loading ? '发送中...' : '发送重置链接'}
            </button>
            <a
              href="/login"
              className="block w-full text-center text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              返回登录
            </a>
          </form>
        )}
      </div>
    </div>
  );
}
