// 隐形认证 — 仅通过手势触发（双击 ⚡ 或 Ctrl+Enter）
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Modal } from './ui';

interface Props {
  onClose: () => void;
}

export function AuthModal({ onClose }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const ok = await login(email.trim(), password);
      // SPA 导航（替代整页刷新）；token 由 authStore 持久化，axios 拦截器逐请求读取
      if (ok) navigate('/channels');
      else setError('密码错误');
    } catch {
      setError('密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    // 批次 I-2：收编 ui/Modal（§4.3 正本）；bodyStyle 保原 24px 整体 padding（原手写 modal-body 内联 space-5）
    <Modal onClose={onClose} maxWidth="24rem" bodyStyle={{ padding: 'var(--space-5)' }}>
        {/* Email/password form（P3-a 死面清退：OAuth 按钮与「忘记密码」入口已删——
            后端无 /auth/google|github|forgot-password|reset-password 路由，整条链路从未可用） */}
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="admin@dommaker.cn"
            autoFocus
            className="input w-full mb-2"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            placeholder="••••••••"
            className="input w-full mb-3"
          />
          {error && <p className="u-err text-xs mb-3">{error}</p>}
          <button
            type="submit"
            disabled={loading || !email.trim() || !password.trim()}
            className="btn btn-primary w-full"
          >
            {loading ? '...' : '确认'}
          </button>
        </form>
    </Modal>
  );
}
