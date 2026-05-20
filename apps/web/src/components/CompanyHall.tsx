// CompanyHall - 公司大厅布局组件
import { Link } from 'react-router-dom';
import { CompanyHallCard } from './CompanyHallCard';
import { CEOInput } from './CEOInput';
import type { CompanyStats } from '../hooks/useCompanyStats';
import '../styles/theme.css';

interface CompanyHallProps {
  onCommandSubmit: (command: string, useLLM: boolean) => Promise<void>;
  isAnalyzing: boolean;
  roles?: Array<{ id: string; name: string; type: string }>;
  projects?: Array<{ id: string; name: string }>;
  workflows?: Array<{ id: string; name: string; usageScenario?: string }>;
  stats?: CompanyStats | null;
}

export function CompanyHall({
  onCommandSubmit,
  isAnalyzing,
  roles = [],
  projects = [],
  workflows = [],
  stats,
}: CompanyHallProps) {
  // 🆕 stats 从 props 获取，不再调用 useCompanyStats

  // 空间卡片配置
  const spaceCards = [
    {
      icon: '👔',
      title: 'CEO 办公室',
      description: '下达指令、任务概览',
      to: '/',
      variant: 'primary' as const,
      stats: stats ? [
        { label: '进行中', value: stats.activeTasks, color: 'success' as const },
        { label: '待处理', value: stats.pendingTasks },
      ] : [],
      action: undefined,
    },
    {
      icon: '👥',
      title: '角色管理',
      description: 'Agent 角色配置',
      to: '/roles',
      stats: stats ? [
        { label: '角色', value: stats.totalRoles },
      ] : [],
    },
    {
      icon: '📋',
      title: 'PMO 管理',
      description: '项目 + 目标追踪',
      to: '/pmo',
      variant: 'accent' as const,
      stats: stats ? [
        { label: '进行中', value: stats.activeTasks, color: 'success' as const },
        { label: '今日完成', value: stats.completedTasksToday },
      ] : [],
    },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-auto" style={{ background: 'var(--bg-primary)' }}>
      {/* 顶部：工作室信息 */}
      <div 
        className="px-6 py-4"
        style={{ 
          background: 'linear-gradient(to right, rgba(99, 102, 241, 0.05), rgba(139, 92, 246, 0.05))',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div 
              className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg"
              style={{ background: 'linear-gradient(to bottom right, #6366f1, #8b5cf6)' }}
            >
              🤖
            </div>
            <div>
              <div className="font-bold" style={{ color: 'var(--text-primary)' }}>
                {stats?.name || '我的 Agent Studio'}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {stats?.totalRoles || 0} 名成员
              </div>
            </div>
          </div>
          
          {/* 快捷操作 */}
          <div className="flex items-center gap-2">
            <Link
              to="/settings"
              className="btn btn-ghost text-sm"
              style={{ padding: '6px 12px' }}
            >
              ⚙️ 设置
            </Link>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          
          {/* CEO 指令区 */}
          <div 
            className="p-4 rounded-xl"
            style={{ 
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">👔</span>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                CEO 指令中心
              </span>
            </div>
            <CEOInput
              onSubmit={onCommandSubmit}
              isLoading={isAnalyzing}
              projects={projects}
            />
          </div>

          {/* 空间卡片网格 */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-lg">🏢</span>
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                功能空间
              </span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {spaceCards.map((card, index) => (
                <CompanyHallCard
                  key={index}
                  icon={card.icon}
                  title={card.title}
                  description={card.description}
                  to={card.to}
                  variant={card.variant}
                  stats={card.stats}
                  action={card.action}
                />
              ))}
            </div>
          </div>

          {/* 今日概览 */}
          {stats && (
            <div 
              className="p-4 rounded-xl"
              style={{ 
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">📈</span>
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  今日概览
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="text-2xl font-bold" style={{ color: 'var(--success)' }}>
                    {stats.todayStats.tasksCompleted}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    完成任务
                  </div>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>
                    {stats.onlineRoles}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    在线角色
                  </div>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="text-2xl font-bold" style={{ color: 'var(--info)' }}>
                    {stats.todayStats.messages}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    今日消息
                  </div>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div className="text-2xl font-bold" style={{ color: 'var(--warning)' }}>
                    {formatTokens(stats.todayStats.cost)}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    今日消耗
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CompanyHall;
