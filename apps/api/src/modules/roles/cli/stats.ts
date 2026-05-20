import type { StatsOptions, LevelStats } from '../types';

// Mock 数据
const mockStats: Record<string, LevelStats> = {
  '1': {
    total: 50,
    byLevel: { 1: 20, 2: 15, 3: 10, 4: 5 },
    active: 45,
    inactive: 5
  },
};

export async function runStats(options: StatsOptions): Promise<{ output: string; error?: string }> {
  if (options.company === 'invalid') {
    return { output: '', error: '无效公司 ID' };
  }
  
  const stats = mockStats[options.company] || { total: 0, byLevel: {}, active: 0, inactive: 0 };
  
  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify(stats, null, 2) };
  }
  
  // table 格式
  const lines = [
    `Total: ${stats.total} roles`,
    `L1: ${stats.byLevel[1] || 0}, L2: ${stats.byLevel[2] || 0}, L3: ${stats.byLevel[3] || 0}, L4: ${stats.byLevel[4] || 0}`,
    `Active: ${stats.active}, Inactive: ${stats.inactive}`
  ];
  return { output: lines.join('\n') };
}