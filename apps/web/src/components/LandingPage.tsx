// Lurk Wall: 个人网站展示页 — 不提示登录，不显示入口
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { AuthModal } from './AuthModal';

export function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const init = useAuthStore((s) => s.init);

  // 尝试恢复已有 session（静默，不弹窗）
  useEffect(() => { init(); }, [init]);

  // 已登录 → 重定向到频道
  useEffect(() => {
    if (isAuthenticated) {
      window.location.href = '/channels';
    }
  }, [isAuthenticated]);

  // 双击标题或按 Ctrl+Enter 触发认证
  const handleSecretGesture = () => setShowAuth(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') setShowAuth(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen u-text flex flex-col items-center justify-center px-4" style={{ background: 'var(--bg-primary)' }}>
      <div className="text-center max-w-2xl">
        {/* 品牌 */}
        <div
          className="inline-block mb-6 cursor-default select-none"
          onDoubleClick={handleSecretGesture}
          title=""
        >
          <span className="text-5xl">⚡</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold mb-3 tracking-tight">
          Agent Studio
        </h1>
        <p className="text-base u-text-3 mb-12 max-w-md mx-auto leading-relaxed">
          我的 AI 开发助手。从需求分析到代码审查，7×24 自主运行。
        </p>

        {/* 能力卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-16">
          {[
            { icon: '📋', label: '需求分析', desc: '自动拆解验收标准' },
            { icon: '⚙️', label: 'TDD 开发', desc: '写测试→实现→通过' },
            { icon: '🔍', label: '多立场审查', desc: '安全/性能/架构' },
            { icon: '📚', label: 'Wiki 沉淀', desc: '自动归档知识' },
            { icon: '📊', label: '周报审计', desc: '趋势+异常检测' },
            { icon: '🚨', label: '自动修复', desc: 'Triage 自愈' },
          ].map((f) => (
            <div
              key={f.label}
              className="u-surface-2 border u-border rounded-xl p-5 text-center"
            >
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="text-sm font-medium mb-1">{f.label}</div>
              <div className="text-xs u-text-2">{f.desc}</div>
            </div>
          ))}
        </div>

        {/* 状态指示（无文字，仅色点） */}
        <div className="flex items-center justify-center gap-2 mb-16">
          <span className="w-1.5 h-1.5 rounded-full u-ok-bg" title="运行中" />
          <span className="text-xs u-text-2">running</span>
        </div>
      </div>

      {/* Auth Modal — 仅通过手势触发 */}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  );
}
