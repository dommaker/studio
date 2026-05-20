// useDashboardData - 首页聚合数据 Hook（优化首屏加载）
import { useState, useEffect } from 'react';
import { api } from '../api';
import type { CompanyStats } from './useCompanyStats';

export interface DashboardData {
  // 公司统计
  stats: CompanyStats | null;
  
  // 补全数据
  roles: Array<{ id: string; name: string; type: string; companyId?: string }>;
  workflows: Array<{ id: string; name: string; usageScenario?: string }>;
  projects: Array<{ id: string; name: string }>;
  companies: Array<{ id: string; name: string }>;
  
  // 默认公司
  defaultCompanyId: string;
}

export interface UseDashboardDataOptions {
  companyId?: string;
  refreshInterval?: number;
}

export function useDashboardData(options: UseDashboardDataOptions = {}) {
  const { companyId, refreshInterval = 30000 } = options;
  
  const [data, setData] = useState<DashboardData>({
    stats: null,
    roles: [],
    workflows: [],
    projects: [],
    companies: [],
    defaultCompanyId: '',
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchDashboard = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // 并行获取所有数据
      const [
        companiesRes,
        rolesRes,
        goalsRes,
        goalsStatsRes,
      ] = await Promise.all([
        api.get('/companies').catch(() => ({ data: { data: [] } })),
        api.get('/roles', { params: { limit: 100 } }).catch(() => ({ data: { data: [] } })),
        api.get('/goals', { params: { limit: 20 } }).catch(() => ({ data: { data: [] } })),
        api.get('/goals/stats').catch(() => ({ data: { data: {} } })),
      ]);

      const companies = companiesRes.data?.data || [];
      const roles = rolesRes.data?.data || [];
      const goals = goalsRes.data?.data || [];
      const goalStats = goalsStatsRes.data?.data || {};
      
      // 计算统计数据
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      const onlineRoles = roles.filter((r: any) => r.status === 'active' || r.status === 'working').length;
      const workingRoles = roles.filter((r: any) => r.status === 'working').length;
      const activeGoals = goalStats.activeGoals || goals.filter((g: any) => g.status === 'executing').length;
      const completedGoals = goalStats.completedGoals || goals.filter((g: any) => g.status === 'completed' || g.status === 'succeeded').length;
      const runningAgents = goalStats.runningGoalExecutions || 0;
      const completedGoalsToday = goals.filter((g: any) =>
        (g.status === 'completed' || g.status === 'succeeded') &&
        new Date(g.completedAt || g.updatedAt) >= todayStart
      ).length;
      // 默认公司
      const defaultCompanyId = roles[0]?.companyId || companies[0]?.id || '';
      const company = companies[0] || { id: 'default', name: '我的工作室' };
      
      // 组装数据
      setData({
        stats: {
          id: company.id,
          name: company.name,
          size: company.size || 'small',
          totalRoles: roles.length,
          onlineRoles,
          workingRoles,
          idleRoles: roles.length - onlineRoles,
          activeGoals,
          completedGoals,
          runningAgents,
          activeTasks: activeGoals,
          pendingTasks: goals.filter((g: any) => g.status === 'pending').length,
          completedTasksToday,
          todayStats: {
            tasksCompleted: completedGoalsToday,
            messages: 0,
            cost: 0,
          },
          monthlyStats: {
            totalCost: 0,
            totalRevenue: 0,
            avgQualityScore: 0,
          },
        },
        roles: roles.map((r: any) => ({
          id: r.id,
          name: r.name,
          type: r.type || 'agent',
          companyId: r.companyId,
        })),
        workflows: workflows.map((w: any) => ({
          id: w.id,
          name: w.name,
          usageScenario: w.usageScenario,
        })),
        projects: [],
        companies,
        defaultCompanyId,
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch dashboard'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
    
    if (refreshInterval > 0) {
      const interval = setInterval(fetchDashboard, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [companyId, refreshInterval]);

  return {
    data,
    loading,
    error,
    refresh: fetchDashboard,
  };
}

export default useDashboardData;
