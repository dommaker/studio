// PMOCard - PMO 模块入口卡片
import { useCallback, useEffect, useState } from 'react';
import { CompanyHallCard } from './CompanyHallCard';
import { runtimeWorkflowApi } from '../api';
import { okrApi } from '../api/pmo';
import '../styles/theme.css';

interface PMOStats {
  activeOKRs: number;
  totalProjects: number;
  activeProjects: number;
  completedThisMonth: number;
}

interface PMOCardProps {
  companyId?: string;
}

export function PMOCard({ companyId }: PMOCardProps) {
  const [stats, setStats] = useState<PMOStats | null>(null);
  const [loading, setLoading] = useState(true);

  // companyId 切换时在渲染期同步置回加载态（替代原 effect 内的同步 setLoading）
  const [prevCompanyId, setPrevCompanyId] = useState(companyId);
  if (prevCompanyId !== companyId) {
    setPrevCompanyId(companyId);
    setLoading(true);
  }

  const loadStats = useCallback(async () => {
    try {
      // 并行获取 OKR 和执行数据
      const [okrRes, projectsRes] = await Promise.all([
        companyId
          ? okrApi.list(companyId)
          : Promise.resolve({ data: { data: [] } }),
        runtimeWorkflowApi.listExecutions({ limit: 50 }).catch(() => ({ data: { data: [] } })),
      ]);

      const okrs = okrRes.data?.data || [];
      const projects = projectsRes.data?.data || [];

      // 计算统计数据
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const pmoStats: PMOStats = {
        activeOKRs: okrs.filter((o: { status?: string }) => o.status === 'active').length,
        totalProjects: projects.length,
        activeProjects: projects.filter((p: { status?: string; startedAt?: string }) =>
          p.status === 'running' || p.status === 'pending'
        ).length,
        completedThisMonth: projects.filter((p: { status?: string; startedAt?: string }) =>
          (p.status === 'succeeded' || p.status === 'completed') &&
          new Date(p.startedAt) >= monthStart
        ).length,
      };

      setStats(pmoStats);
    } catch (err) {
      console.error('Failed to load PMO stats:', err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    // 微任务里触发加载：loadStats 为多 await async 函数，编译器对 effect 内同步调用保守告警
    void Promise.resolve().then(loadStats);
  }, [loadStats]);

  if (loading) {
    return (
      <CompanyHallCard
        icon="📊"
        title="PMO 管理"
        description="加载中..."
        to="/pmo"
      />
    );
  }

  return (
    <CompanyHallCard
      icon="📊"
      title="PMO 管理"
      description="OKR + 项目组合"
      to="/pmo"
      variant="accent"
      stats={stats ? [
        { label: '进行中', value: stats.activeProjects, color: 'success' },
        { label: 'OKR', value: stats.activeOKRs },
      ] : []}
    />
  );
}

export default PMOCard;