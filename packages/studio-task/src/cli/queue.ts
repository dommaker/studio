import type { QueueOptions, TaskListItem } from '../types';

const mockTasks: TaskListItem[] = [
  { id: '1', company: '1', name: 'Task 1', status: 'pending', createdAt: new Date() },
  { id: '2', company: '1', name: 'Task 2', status: 'running', createdAt: new Date() },
  { id: '3', company: '1', name: 'Task 3', status: 'completed', createdAt: new Date(), completedAt: new Date() },
  { id: 'failed', company: '1', name: 'Failed Task', status: 'failed', createdAt: new Date() },
];
const companies = { '1': 'Company A', 'empty': 'Empty Co' };

export async function runQueue(options: QueueOptions): Promise<{ output: string; error?: string }> {
  const companyName = companies[options.company as keyof typeof companies];
  if (!companyName && options.company !== 'nonexistent') {
    return { output: '', error: '公司不存在' };
  }
  if (options.company === 'nonexistent') {
    return { output: '', error: '公司不存在' };
  }

  let tasks = mockTasks.filter(t => t.company === options.company);
  if (options.status) {
    tasks = tasks.filter(t => t.status === options.status);
  }

  if (options.company === 'empty' || tasks.length === 0) {
    return { output: `${companyName || options.company} - 无任务` };
  }

  const format = options.format || 'table';
  if (format === 'json') {
    return { output: JSON.stringify({ company: options.company, tasks, total: tasks.length }, null, 2) };
  }

  const lines = [`${companyName} - Task Queue`];
  tasks.forEach(t => {
    lines.push(`ID: ${t.id} | Name: ${t.name} | Status: ${t.status}`);
  });
  return { output: lines.join('\n') };
}