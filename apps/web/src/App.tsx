// App.tsx - Agent Studio - 路由重构
import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom';
const ChannelHomeRedirect = lazy(() => import('./pages/ChannelHomeRedirect').then(m => ({ default: m.ChannelHomeRedirect })));
const TriageBanner = lazy(() => import('./components/TriageBanner').then(m => ({ default: m.TriageBanner })));
const CommandPalette = lazy(() => import('./components/CommandPalette').then(m => ({ default: m.CommandPalette })));

// 路由级代码分割 - 懒加载页面组件
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const AuditLogsPage = lazy(() => import('./pages/AuditLogsPage').then(m => ({ default: m.AuditLogsPage })));
const PMOPage = lazy(() => import('./pages/PMOPage').then(m => ({ default: m.PMOPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then(m => ({ default: m.KnowledgePage })));
const ChannelDetailPage = lazy(() => import('./pages/ChannelDetailPage').then(m => ({ default: m.ChannelDetailPage })));
const LibraryPage = lazy(() => import('./pages/LibraryPage').then(m => ({ default: m.LibraryPage })));
const LibraryDocPage = lazy(() => import('./pages/LibraryDocPage').then(m => ({ default: m.LibraryDocPage })));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage').then(m => ({ default: m.ProjectDetailPage })));
const OAuthCallback = lazy(() => import('./components/OAuthCallback').then(m => ({ default: m.OAuthCallback })));
const WorkUnitListPage = lazy(() => import('./pages/WorkUnitListPage').then(m => ({ default: m.WorkUnitListPage })));
const WorkUnitDetailPage = lazy(() => import('./pages/WorkUnitDetailPage').then(m => ({ default: m.WorkUnitDetailPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const AgentDashboardPage = lazy(() => import('./pages/AgentDashboardPage').then(m => ({ default: m.AgentDashboardPage })));
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage').then(m => ({ default: m.AgentDetailPage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then(m => ({ default: m.MonitoringPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then(m => ({ default: m.WorkspacePage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));

const PageLoader = () => (
  <div className="flex items-center justify-center h-full">
    <div className="loading-spinner" />
  </div>
);

import { ThemeProvider } from './contexts/ThemeContext';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/SidebarNew';
import { useAuthStore } from './stores/authStore';
import { LandingPage } from './components/LandingPage';
import { WebSocketProvider } from './api/websocket';
import { channelApi } from './api/channel';
import { useRosterStore } from './stores/rosterStore';
import { useRequirementChainStoreSync } from './hooks/useRequirementChainStoreSync';
import { usePmoDataStoreSync } from './hooks/usePmoDataStoreSync';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { StudioRoleSetupModal } from './components/setup/StudioRoleSetupModal';
import { FirstRoleSetupModal } from './components/setup/FirstRoleSetupModal';
import { joinDefaultChannel } from './components/setup/joinChannel';
import { isStudioRoleSetupDismissed, isFirstRoleSetupDismissed } from './components/setup/dismissed';
import './styles/theme.css';

// #412：REQ chain 数据面 SSE 接线（App 级单点、零渲染；useWebSocketContext 依赖 Provider，故置于 Provider 内）
function RequirementChainSync() {
  useRequirementChainStoreSync();
  return null;
}

// #456：PMO 数据面接线（App 级单点、零渲染；消费方分布在 PMO/阅览室/FileRefChip，不随页面挂卸增减）
function PmoDataSync() {
  usePmoDataStoreSync();
  return null;
}

// #474：/project/:id 旧路由收编——双路由渲染同一页面已合并为 /pmo/project/:id 唯一入口，
// 存量链接（书签/外部引用）在此 301 式重定向（replace 不留历史栈）
function LegacyProjectRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/pmo/project/${projectId}`} replace />;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isGuest = useAuthStore((s) => s.isGuest());
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  // 本地 state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // 批次 D-2 项 8：Cmd/Ctrl+K 全局搜索面板（CommandPalette）；再按一次 ⌘K 关闭
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcuts([
    { key: 'k', mod: true, allowInInput: true, handler: () => setPaletteOpen((o) => !o) },
  ]);
  // AC-2.2/2.3: studio 角色 provider=null + 无用户角色 弹框提醒
  const [studioRoleSetupOpen, setStudioRoleSetupOpen] = useState(false);
  const [firstRoleSetupOpen, setFirstRoleSetupOpen] = useState(false);

  // AC-2.1~2.3: 启动时检测 studio 角色 provider + 是否有已配置 provider 的用户角色
  // #403：agent 列表读 rosterStore 客户端切片（listAllAgents 全量正本，ADR 决策 2）——
  // ensureFresh 触发首拉（TTL/单飞与其他消费方收敛），profiles 切片成功落库后一次性评估
  const profiles = useRosterStore((s) => s.profiles);
  const profilesLoadedOnce = useRosterStore((s) => s.profilesLoadedOnce);
  const token = useAuthStore((s) => s.token);
  const bootEvaluatedRef = useRef(false);
  const bootTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    void useRosterStore.getState().ensureFresh();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      bootEvaluatedRef.current = false;
      bootTokenRef.current = token;
      return;
    }
    // 换号（token 变）重置一次性评估：新账号切片由 ensureFresh 的 tokenChanged 逻辑保证重拉
    if (bootTokenRef.current !== token) {
      bootTokenRef.current = token;
      bootEvaluatedRef.current = false;
    }
    if (bootEvaluatedRef.current) return;
    // profiles 切片成功落库才评估（对齐旧 listAgents .then 时机：切片失败静默不评，等后续拉取成功）
    if (!profilesLoadedOnce) return;
    bootEvaluatedRef.current = true;
    const studio = profiles.find(p => p.name === 'studio');
    // AC-2.2: studio provider=null 且未 dismiss -> 弹框
    if (studio && !studio.provider && !isStudioRoleSetupDismissed()) {
      setStudioRoleSetupOpen(true);
    }
    // AC-2.3（F2，2026-07-28）: 无任何 provider 非空的 active 用户角色且未 dismiss -> 弹框
    // （内置三角色 seed 已退役；角色存在但 provider 为空 = 没有可用执行体，同样需要引导）
    const hasConfiguredRole = profiles.some(p => p.name !== 'studio' && p.status === 'active' && !!p.provider);
    if (!hasConfiguredRole && !isFirstRoleSetupDismissed()) {
      setFirstRoleSetupOpen(true);
    }
  }, [isAuthenticated, profiles, profilesLoadedOnce, token]);

  // OAuth callback: bypass guest wall (user is returning from OAuth provider)
  if (location.pathname === '/auth/callback') {
    return (
      <ThemeProvider>
        <Suspense fallback={<PageLoader />}>
          <OAuthCallback />
        </Suspense>
      </ThemeProvider>
    );
  }

  // Forgot/reset password: bypass guest wall
  if (location.pathname === '/forgot-password') {
    return (
      <ThemeProvider>
        <Suspense fallback={<PageLoader />}>
          <ForgotPasswordPage />
        </Suspense>
      </ThemeProvider>
    );
  }
  if (location.pathname === '/reset-password') {
    return (
      <ThemeProvider>
        <Suspense fallback={<PageLoader />}>
          <ResetPasswordPage />
        </Suspense>
      </ThemeProvider>
    );
  }

  // Lurk Wall: guest sees LandingPage, admin sees full Studio
  if (isGuest) {
    return (
      <ThemeProvider>
        <WebSocketProvider>
          <LandingPage />
        </WebSocketProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
    <WebSocketProvider>
    <div className="h-screen flex flex-col u-page-bg">
      {/* #412：REQ chain 数据面 SSE 接线（App 级单点，hook 需 WebSocketProvider 上下文） */}
      <RequirementChainSync />
      {/* #456：PMO 数据面接线（App 级单点） */}
      <PmoDataSync />
      {/* AC-2.2: studio 角色 provider=null 弹框 */}
      <StudioRoleSetupModal
        open={studioRoleSetupOpen}
        onClose={() => setStudioRoleSetupOpen(false)}
        onSave={async (provider) => {
          try {
            // #403：studio 身份来自 boot 已拉好的 rosterStore 切片（弹框只能由检测到 studio 才打开），
            // 保存后强刷切片防 store 残留 provider=null 触发重弹
            const studio = useRosterStore.getState().profiles.find(p => p.name === 'studio');
            if (studio) await channelApi.updateAgent(studio.id, { provider });
            await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
          } catch { /* best-effort */ }
        }}
      />
      {/* AC-2.3: 无用户角色弹框；#465：创建成功后续接「一键加入 #研发」引导（不跳转断点在此补上） */}
      <FirstRoleSetupModal
        open={firstRoleSetupOpen}
        onClose={() => setFirstRoleSetupOpen(false)}
        onCreate={async (data) => {
          try {
            const res = await channelApi.createAgent(data);
            // 刷 roster 切片让新角色即时可见（同 StudioRoleSetupModal 保存后强刷先例）
            await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 }).catch(() => {});
            return { id: res.data.id, name: res.data.name };
          } catch { return null; /* best-effort：创建失败静默关窗（原语义） */ }
        }}
        onJoinChannel={async (agentId) => {
          const channelId = await joinDefaultChannel(agentId);
          if (channelId) navigate(`/channels/${channelId}`);
          return channelId !== null;
        }}
      />

      <TopNav
        onMenuClick={() => setIsSidebarOpen(true)}
        onOpenSearch={() => setPaletteOpen(true)}
      />

      <Suspense fallback={null}><TriageBanner /></Suspense>
      <Suspense fallback={null}><CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} /></Suspense>

      <div className="flex-1 flex min-h-0">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        {/* Mission Control：频道工作区为满高三栏（各栏独立滚动），其余页面保持文档流滚动 */}
        <div
          className={`u-page-bg ${
            /^\/channels\/[^/]+$/.test(location.pathname)
              ? 'flex-1 flex flex-col overflow-hidden min-h-0'
              : 'flex-1 overflow-auto'
          }`}
        >
          <Routes>
            <Route
              path="/"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ChannelHomeRedirect />
                </Suspense>
              }
            />
            {/* #474：双路由合并——/project/:id 不再直挂页面，存量链接重定向到 /pmo/project/:id */}
            <Route path="/project/:projectId" element={<LegacyProjectRedirect />} />
            <Route path="/goals" element={<Navigate to="/workunits" replace />} />
            <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
            <Route path="/audit-logs" element={<Suspense fallback={<PageLoader />}><AuditLogsPage /></Suspense>} />
            <Route path="/channels" element={<Suspense fallback={<PageLoader />}><ChannelHomeRedirect /></Suspense>} />
            <Route path="/channels/:id" element={<Suspense fallback={<PageLoader />}><ChannelDetailPage /></Suspense>} />
            <Route path="/pmo" element={<Suspense fallback={<PageLoader />}><PMOPage /></Suspense>} />
            <Route path="/pmo/project/:projectId" element={<Suspense fallback={<PageLoader />}><ProjectDetailPage /></Suspense>} />
            <Route path="/knowledge" element={<Suspense fallback={<PageLoader />}><KnowledgePage /></Suspense>} />
            <Route path="/library" element={<Suspense fallback={<PageLoader />}><LibraryPage /></Suspense>} />
            <Route path="/library/:id" element={<Suspense fallback={<PageLoader />}><LibraryDocPage /></Suspense>} />
            <Route path="/workunits" element={<Suspense fallback={<PageLoader />}><WorkUnitListPage /></Suspense>} />
            <Route path="/workunits/:id" element={<Suspense fallback={<PageLoader />}><WorkUnitDetailPage /></Suspense>} />
            <Route path="/agents" element={<Suspense fallback={<PageLoader />}><AgentDashboardPage /></Suspense>} />
            <Route path="/agents/:profileId" element={<Suspense fallback={<PageLoader />}><AgentDetailPage /></Suspense>} />
            <Route path="/monitoring" element={<Suspense fallback={<PageLoader />}><MonitoringPage /></Suspense>} />
            <Route path="/workspaces/:id" element={<Suspense fallback={<PageLoader />}><WorkspacePage /></Suspense>} />
            <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFoundPage /></Suspense>} />
          </Routes>
        </div>
      </div>

    </div>
    </WebSocketProvider>
    </ThemeProvider>
  );
}
