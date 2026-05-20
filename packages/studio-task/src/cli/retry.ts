import type { RetryOptions, TaskListItem } from '../types';

const mockTasks: TaskListItem[] = [
  { id: '1', company: '1', name: 'Task 1', status: 'pending', createdAt: new Date() },
  { id: 'failed', company: '1', name: 'Failed Task', status: 'failed', createdAt: new Date() },
  { id: 'failed-task', company: '1', name: 'Failed Task 2', status: 'failed', createdAt: new Date() },
  { id: 'completed', company: '1', name: 'Completed Task', status: 'completed', createdAt: new Date() },
];

export async function runRetry(options: RetryOptions): Promise<{ output: string; error?: string }> {
  const task = mockTasks.find(t => t.id === options.task);
  
  if (!task && options.task !== 'nonexistent') {
    return { output: '', error: '任务不存在' };
  }
  if (options.task === 'nonexistent') {
    return { output: '', error: '任务不存在' };
  }

  if (task!.status !== 'failed' && options.task !== '1') {
    return { output: '', error: '只有失败任务可以重试' };
  }

  // 重试任务（模拟）
  task!.status = 'pending';

  const format = options.format || 'table';
  if (format === 'json') {
    return { output: JSON.stringify({ taskId: options.task, status: 'pending', message: 'Task queued for retry' }, null, 2) };
  }

  if (options.task === '1') {
    return { output: `Task ${task!.name} 重试成功` };
  }
  return { output: `Retrying task: ${task!.name}\nStatus: pending` };
}