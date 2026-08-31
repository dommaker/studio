// App.tsx - Agent Studio - 路由重构
import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
const ChannelHomeRedirect = lazy(() => import('./pages/ChannelHomeRedirect').then(m => ({ default: m.ChannelHomeRedirect })));
const TriageBanner = lazy(() => import('./components/TriageBanner').then(m => ({ default: m.TriageBanner })));

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
const RolesSetup = lazy(() => import('./pages/RolesSetup').then(m => ({ default: m.RolesSetup })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const AgentDashboardPage = lazy(() => import('./pages/AgentDashboardPage').then(m => ({ default: m.AgentDashboardPage })));
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage').then(m => ({ default: m.AgentDetailPage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then(m => ({ default: m.MonitoringPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then(m => ({ default: m.WorkspacePage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));

const PageLoader = () => (
  <div className="flex items-center justify-center h-full">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 u-border-2 "></div>
  </div>
);

import { ThemeProvider } from './contexts/ThemeContext';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/SidebarNew';
import { useAuthStore } from './stores/authStore';
import { LandingPage } from './components/LandingPage';
import { WebSocketProvider } from './api/websocket';
import { channelApi } from './api/channel';
import { StudioRoleSetupModal } from './components/setup/StudioRoleSetupModal';
import { FirstRoleSetupModal } from './components/setup/FirstRoleSetupModal';
import { isStudioRoleSetupDismissed, isFirstRoleSetupDismissed } from './components/setup/dismissed';
import './styles/theme.css';

export default function App() {
  const location = useLocation();
  const isGuest = useAuthStore((s) => s.isGuest());
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  // 本地 state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // AC-2.2/2.3: studio 角色 provider=null + 无用户角色 弹框提醒
  const [studioRoleSetupOpen, setStudioRoleSetupOpen] = useState(false);
  const [firstRoleSetupOpen, setFirstRoleSetupOpen] = useState(false);

  // AC-2.1~2.3: 启动时检测 studio 角色 provider + 是否有已配置 provider 的用户角色
  useEffect(() => {
    if (!isAuthenticated) return;
    channelApi.listAgents(undefined, { includeSystem: true })
      .then((res) => {
        const profiles = res.data.data;
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
      })
      .catch(() => { /* 静默，不阻塞 UI */ });
  }, [isAuthenticated]);

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
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* AC-2.2: studio 角色 provider=null 弹框 */}
      <StudioRoleSetupModal
        open={studioRoleSetupOpen}
        onClose={() => setStudioRoleSetupOpen(false)}
        onSave={async (provider) => {
          try {
            const res = await channelApi.listAgents(undefined, { includeSystem: true });
            const studio = res.data.data.find(p => p.name === 'studio');
            if (studio) await channelApi.updateAgent(studio.id, { provider });
          } catch { /* best-effort */ }
        }}
      />
      {/* AC-2.3: 无用户角色弹框 */}
      <FirstRoleSetupModal
        open={firstRoleSetupOpen}
        onClose={() => setFirstRoleSetupOpen(false)}
        onCreate={async (data) => {
          try { await channelApi.createAgent(data); } catch { /* best-effort */ }
        }}
      />

      <TopNav
        onMenuClick={() => setIsSidebarOpen(true)}
      />

      <Suspense fallback={null}><TriageBanner /></Suspense>

      <div className="flex-1 flex min-h-0">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        {/* Mission Control：频道工作区为满高三栏（各栏独立滚动），其余页面保持文档流滚动 */}
        <div
          className={
            /^\/channels\/[^/]+$/.test(location.pathname)
              ? 'flex-1 flex flex-col overflow-hidden min-h-0'
              : 'flex-1 overflow-auto'
          }
          style={{ background: 'var(--bg-primary)' }}
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
            <Route path="/project/:projectId" element={<Suspense fallback={<PageLoader />}><ProjectDetailPage /></Suspense>} />
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
            <Route path="/setup/roles" element={<Suspense fallback={<PageLoader />}><RolesSetup /></Suspense>} />
            <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFoundPage /></Suspense>} />
          </Routes>
        </div>
      </div>

    </div>
    </WebSocketProvider>
    </ThemeProvider>
  );
}
