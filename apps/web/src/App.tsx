// App.tsx - Agent Studio - 路由重构
import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
const ChannelListPage = lazy(() => import('./pages/ChannelListPage').then(m => ({ default: m.ChannelListPage })));
const TriageBanner = lazy(() => import('./components/TriageBanner').then(m => ({ default: m.TriageBanner })));

// 路由级代码分割 - 懒加载页面组件
const GoalListPage = lazy(() => import('./pages/GoalListPage').then(m => ({ default: m.GoalListPage })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const ToolsStdPage = lazy(() => import('./pages/ToolsStdPage').then(m => ({ default: m.ToolsStdPage })));
const AuditLogsPage = lazy(() => import('./pages/AuditLogsPage').then(m => ({ default: m.AuditLogsPage })));
const PMOPage = lazy(() => import('./pages/PMOPage').then(m => ({ default: m.PMOPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then(m => ({ default: m.KnowledgePage })));
const KnowledgeImportPage = lazy(() => import('./pages/KnowledgeImportPage').then(m => ({ default: m.KnowledgeImportPage })));
const ChannelDetailPage = lazy(() => import('./pages/ChannelDetailPage').then(m => ({ default: m.ChannelDetailPage })));
const WikiPage = lazy(() => import('./pages/WikiPage').then(m => ({ default: m.WikiPage })));
const WikiDocPage = lazy(() => import('./pages/WikiDocPage').then(m => ({ default: m.WikiDocPage })));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage').then(m => ({ default: m.ProjectDetailPage })));
const OAuthCallback = lazy(() => import('./components/OAuthCallback').then(m => ({ default: m.OAuthCallback })));
const WorkUnitListPage = lazy(() => import('./pages/WorkUnitListPage').then(m => ({ default: m.WorkUnitListPage })));
const AgentDashboardPage = lazy(() => import('./pages/AgentDashboardPage').then(m => ({ default: m.AgentDashboardPage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then(m => ({ default: m.MonitoringPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then(m => ({ default: m.WorkspacePage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));

const PageLoader = () => (
  <div className="flex items-center justify-center h-full">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
  </div>
);

import { ThemeProvider } from './contexts/ThemeContext';
import { TopNav } from './components/TopNav';
import { Sidebar } from './components/SidebarNew';
import { GlobalModals } from './components/GlobalModals';
import { useAgentStore, useRuntimeStore } from './stores';
import { useAuthStore } from './stores/authStore';
import { LandingPage } from './components/LandingPage';
import { useWebSocket, WebSocketProvider } from './api/websocket';
import { useWebSocketHandlers } from './hooks/useWebSocketHandlers';
import { useGlobalModals } from './hooks/useGlobalModals';
import './styles/theme.css';

export default function App() {
  const { t } = useTranslation();
  const location = useLocation();
  const { loadAgents } = useAgentStore();
  const { loadExecutions, runtimeExecutions } = useRuntimeStore();
  const isGuest = useAuthStore((s) => s.isGuest());
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  const {
    currentExecution, setCurrentExecution,
    handleWebSocketMessage,
  } = useWebSocketHandlers(() => {});

  const {
    showAgentRegistry, setShowAgentRegistry,
    showResult, setShowResult,
    selectedProject, setSelectedProject,
    handleViewDetails,
  } = useGlobalModals();

  // 本地 state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // WebSocket
  const { status: wsStatus } = useWebSocket({
    onMessage: handleWebSocketMessage,
    reconnect: true,
  });

  // 初始化
  useEffect(() => {
    loadAgents();
    loadExecutions();
  }, [loadAgents, loadExecutions]);

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
      <GlobalModals
        showResult={showResult}
        currentExecution={currentExecution}
        onCloseResult={() => setShowResult(false)}
        showAgentRegistry={showAgentRegistry}
        onCloseAgentRegistry={() => setShowAgentRegistry(false)}
        selectedProject={selectedProject}
        onCloseProject={() => setSelectedProject(null)}
      />

      <TopNav
        wsStatus={wsStatus === 'connected' ? 'connected' : 'disconnected'}
        onMenuClick={() => setIsSidebarOpen(true)}
      />

      <Suspense fallback={null}><TriageBanner /></Suspense>

      <div className="flex-1 flex">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        <div className="flex-1 overflow-auto" style={{ background: 'var(--bg-primary)' }}>
          <Routes>
            <Route
              path="/"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ChannelListPage />
                </Suspense>
              }
            />
            <Route path="/project/:projectId" element={<Suspense fallback={<PageLoader />}><ProjectDetailPage /></Suspense>} />
            <Route path="/goals" element={<Suspense fallback={<PageLoader />}><GoalListPage /></Suspense>} />
            <Route path="/skills" element={<Suspense fallback={<PageLoader />}><ToolsStdPage /></Suspense>} />
            <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
            <Route path="/audit-logs" element={<Suspense fallback={<PageLoader />}><AuditLogsPage /></Suspense>} />
            <Route path="/channels" element={<Suspense fallback={<PageLoader />}><ChannelListPage /></Suspense>} />
            <Route path="/channels/:id" element={<Suspense fallback={<PageLoader />}><ChannelDetailPage /></Suspense>} />
            <Route path="/pmo" element={<Suspense fallback={<PageLoader />}><PMOPage /></Suspense>} />
            <Route path="/pmo/project/:projectId" element={<Suspense fallback={<PageLoader />}><ProjectDetailPage /></Suspense>} />
            <Route path="/knowledge" element={<Suspense fallback={<PageLoader />}><KnowledgePage /></Suspense>} />
            <Route path="/knowledge/import" element={<Suspense fallback={<PageLoader />}><KnowledgeImportPage /></Suspense>} />
            <Route path="/wiki" element={<Suspense fallback={<PageLoader />}><WikiPage /></Suspense>} />
            <Route path="/wiki/:id" element={<Suspense fallback={<PageLoader />}><WikiDocPage /></Suspense>} />
            <Route path="/workunits" element={<Suspense fallback={<PageLoader />}><WorkUnitListPage /></Suspense>} />
            <Route path="/agents" element={<Suspense fallback={<PageLoader />}><AgentDashboardPage /></Suspense>} />
            <Route path="/monitoring" element={<Suspense fallback={<PageLoader />}><MonitoringPage /></Suspense>} />
            <Route path="/workspaces/:id" element={<Suspense fallback={<PageLoader />}><WorkspacePage /></Suspense>} />
          </Routes>
        </div>
      </div>

    </div>
    </WebSocketProvider>
    </ThemeProvider>
  );
}
