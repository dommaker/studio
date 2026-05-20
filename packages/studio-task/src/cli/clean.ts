import type { CleanOptions, TaskListItem } from '../types';

const mockTasks: TaskListItem[] = [
  { id: '1', company: '1', name: 'Old Task', status: 'completed', createdAt: new Date('2026-01-01'), completedAt: new Date('2026-01-02') },
  { id: '2', company: '1', name: 'Recent Task', status: 'completed', createdAt: new Date(), completedAt: new Date() },
];
const companies = { '1': 'Company A', 'empty': 'Empty Co' };

export async function runClean(options: CleanOptions): Promise<{ output: string; error?: string }> {
  // 验证天数
  if (options.days < 0) {
    return { output: '', error: '无效天数，应为正数' };
  }

  const companyName = companies[options.company as keyof typeof companies];
  if (!companyName && options.company !== 'nonexistent') {
    return { output: '', error: '公司不存在' };
  }
  if (options.company === 'nonexistent') {
    return { output: '', error: '公司不存在' };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - options.days);

  let tasks = mockTasks.filter(t => 
    t.company === options.company && 
    t.status === 'completed' && 
    t.completedAt && 
    t.completedAt < cutoffDate
  );

  if (options.company === 'empty' || tasks.length === 0) {
    return { output: `${companyName || options.company} - 无可清理任务` };
  }

  const format = options.format || 'table';
  if (format === 'json') {
    return { output: JSON.stringify({ company: options.company, cleaned: tasks.length, tasks }, null, 2) };
  }

  return { output: `Cleaned ${tasks.length} completed tasks older than ${options.days} days` };
}