import type { RunOptions, TaskListItem } from '../types';

const mockTasks: TaskListItem[] = [
  { id: '1', company: '1', name: 'Task 1', status: 'pending', createdAt: new Date() },
  { id: 'pending-task', company: '1', name: 'Pending Task', status: 'pending', createdAt: new Date() },
  { id: 'running', company: '1', name: 'Running Task', status: 'running', createdAt: new Date() },
  { id: 'completed', company: '1', name: 'Completed Task', status: 'completed', createdAt: new Date(), completedAt: new Date() },
];

export async function runRun(options: RunOptions): Promise<{ output: string; error?: string }> {
  const task = mockTasks.find(t => t.id === options.task);
  
  if (!task && options.task !== 'nonexistent') {
    return { output: '', error: '任务不存在' };
  }
  if (options.task === 'nonexistent') {
    return { output: '', error: '任务不存在' };
  }

  if (task!.status === 'completed') {
    return { output: `Task ${options.task} 已完成，无需重复执行` };
  }
  if (task!.status === 'running') {
    return { output: `Task ${options.task} 正在运行中` };
  }

  // 执行任务（模拟）
  task!.status = 'completed';
  task!.completedAt = new Date();

  const format = options.format || 'table';
  if (format === 'json') {
    return { output: JSON.stringify({ taskId: options.task, status: 'completed', completedAt: task!.completedAt }, null, 2) };
  }

  return { output: `Executed task: ${task!.name}\nStatus: completed` };
}