// 隐形认证 — 仅通过手势触发（双击 ⚡ 或 Ctrl+Enter）
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

interface Props {
  onClose: () => void;
}

export function AuthModal({ onClose }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const ok = await login('admin@agent-studio.local', password);
      if (ok) window.location.href = '/channels';
      else setError('密码错误');
    } catch {
      setError('密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            placeholder="••••••••"
            autoFocus
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-gray-400 mb-3"
          />
          {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full px-4 py-2.5 bg-gray-700 rounded-lg text-gray-200 text-sm hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : '确认'}
          </button>
        </form>
      </div>
    </div>
  );
}
