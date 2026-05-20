// useCompanyStats - 公司大厅统计数据 Hook
import { useState, useEffect } from 'react';
import { api } from '../api';

export interface CompanyStats {
  // 公司信息
  id: string;
  name: string;
  size: 'small' | 'medium' | 'large';

  // 角色统计
  totalRoles: number;
  onlineRoles: number;
  workingRoles: number;
  idleRoles: number;
  
  // 任务统计
  activeTasks: number;
  pendingTasks: number;
  completedTasksToday: number;
  
  // 会议统计
  activeMeetings: number;
  
  // 今日统计
  todayStats: {
    tasksCompleted: number;
    messages: number;
    cost: number;
  };
  
  // 本月统计
  monthlyStats: {
    totalCost: number;
    totalRevenue: number;
    avgQualityScore: number;
  };
}

export interface UseCompanyStatsOptions {
  companyId?: string;
  refreshInterval?: number; // 刷新间隔（毫秒）
}

export function useCompanyStats(options: UseCompanyStatsOptions = {}) {
  const { companyId, refreshInterval = 30000 } = options;
  
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchStats = async () => {
    if (!companyId) {
      // 没有公司 ID 时，获取默认公司
      try {
        const { data: companies } = await api.get('/companies');
        if (companies.data && companies.data.length > 0) {
          const defaultCompany = companies.data[0];
          await fetchCompanyStats(defaultCompany.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Failed to fetch companies'));
      }
      return;
    }
    
    await fetchCompanyStats(companyId);
  };

  const fetchCompanyStats = async (id: string) => {
    setLoading(true);
    setError(null);
    
    try {
      // 并行获取多个 API 数据
      const [companyRes, rolesRes, tasksRes, meetingsRes] = await Promise.all([
        api.get(`/companies/${id}`),
        api.get('/roles?limit=100').catch(() => ({ data: { data: [] } })),
        api.get('/executions?limit=50').catch(() => ({ data: { data: [] } })),
        api.get('/meetings?limit=20').catch(() => ({ data: { data: [] } })),
      ]);

      const company = companyRes.data;
      const roles = rolesRes.data?.data || [];
      const tasks = tasksRes.data?.data || [];
      const meetings = meetingsRes.data?.data || [];

      // 计算角色状态
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      const onlineRoles = roles.filter((r: any) => r.status === 'active' || r.status === 'working').length;
      const workingRoles = roles.filter((r: any) => r.status === 'working').length;
      const idleRoles = roles.filter((r: any) => r.status === 'idle' || !r.status).length;

      // 计算任务状态
      const activeTasks = tasks.filter((t: any) => 
        t.status === 'running' || t.status === 'pending'
      ).length;
      const pendingTasks = tasks.filter((t: any) => 
        t.status === 'pending'
      ).length;
      const completedTasksToday = tasks.filter((t: any) => 
        (t.status === 'completed' || t.status === 'succeeded') && 
        new Date(t.completedAt || t.updatedAt) >= todayStart
      ).length;

      // 计算会议状态
      const activeMeetings = meetings.filter((m: any) => 
        m.status === 'active' || m.status === 'in_progress'
      ).length;

      // 组装统计数据
      const companyStats: CompanyStats = {
        id: company.id,
        name: company.name,
        size: company.size || 'small',
        totalRoles: roles.length,
        onlineRoles,
        workingRoles,
        idleRoles,
        activeTasks,
        pendingTasks,
        completedTasksToday,
        activeMeetings,
        todayStats: {
          tasksCompleted: completedTasksToday,
          messages: 0,
          cost: 0,
        },
        monthlyStats: {
          totalCost: 0,
          totalRevenue: 0,
          avgQualityScore: 0,
        },
      };

      setStats(companyStats);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch company stats'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    
    // 定时刷新
    if (refreshInterval > 0) {
      const interval = setInterval(fetchStats, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [companyId, refreshInterval]);

  return {
    stats,
    loading,
    error,
    refresh: fetchStats,
  };
}

export default useCompanyStats;
