// Lurk Wall: 个人网站展示页 — 不提示登录，不显示入口
import { useState, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { AuthModal } from './AuthModal';
import {
  IconZap, IconClipboard, IconSettings, IconSearch,
  IconLibrary, IconChart, IconAlertTriangle,
  type IconProps,
} from './ui/icons';

// 批次 G-1：能力卡图标 emoji → ui/icons SVG（#474 图标策略）
const CAPABILITIES: Array<{ icon: (p: IconProps) => ReactNode; label: string; desc: string }> = [
  { icon: IconClipboard, label: '需求分析', desc: '自动拆解验收标准' },
  { icon: IconSettings, label: 'TDD 开发', desc: '写测试→实现→通过' },
  { icon: IconSearch, label: '多立场审查', desc: '安全/性能/架构' },
  { icon: IconLibrary, label: '阅览室沉淀', desc: '自动归档知识' },
  { icon: IconChart, label: '周报审计', desc: '趋势+异常检测' },
  { icon: IconAlertTriangle, label: '自动修复', desc: '出错自动分诊处理' },
];

export function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const init = useAuthStore((s) => s.init);
  const navigate = useNavigate();

  // 尝试恢复已有 session（静默，不弹窗）
  useEffect(() => { init(); }, [init]);

  // 已登录 → 重定向到频道（SPA 导航，替代整页刷新；replace 避免回退键循环）
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/channels', { replace: true });
    }
  }, [isAuthenticated, navigate]);

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
    <div className="min-h-screen u-text flex flex-col items-center justify-center px-4 u-page-bg">
      <div className="text-center max-w-2xl">
        {/* 品牌 */}
        <div
          className="inline-block mb-6 cursor-default select-none"
          onDoubleClick={handleSecretGesture}
          title=""
        >
          <span className="u-accent inline-flex"><IconZap size={48} /></span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold mb-3 tracking-tight">
          Agent Studio
        </h1>
        <p className="text-base u-text-3 mb-12 max-w-md mx-auto leading-relaxed">
          我的 AI 开发助手。从需求分析到代码审查，7×24 自主运行。
        </p>

        {/* 能力卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-16">
          {CAPABILITIES.map(({ icon: Icon, label, desc }) => (
            <div
              key={label}
              className="u-surface-2 border u-border rounded-xl p-5 text-center"
            >
              <div className="mb-2 flex justify-center u-text-2"><Icon size={24} /></div>
              <div className="text-sm font-medium mb-1">{label}</div>
              <div className="text-xs u-text-2">{desc}</div>
            </div>
          ))}
        </div>

        {/* 状态指示（无文字，仅色点） */}
        <div className="flex items-center justify-center gap-2 mb-16">
          <span className="w-1.5 h-1.5 rounded-full u-ok-bg" title="运行中" />
          <span className="text-xs u-text-2">运行中</span>
        </div>
      </div>

      {/* Auth Modal — 仅通过手势触发 */}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  );
}
