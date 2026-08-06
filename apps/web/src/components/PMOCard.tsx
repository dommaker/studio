// PMOCard - PMO 模块入口卡片
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
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

  useEffect(() => {
    loadStats();
  }, [companyId]);

  const loadStats = async () => {
    try {
      setLoading(true);

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
        activeOKRs: okrs.filter((o: any) => o.status === 'active').length,
        totalProjects: projects.length,
        activeProjects: projects.filter((p: any) =>
          p.status === 'running' || p.status === 'pending'
        ).length,
        completedThisMonth: projects.filter((p: any) =>
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
  };

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