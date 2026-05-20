import type { ListOptions, Notification } from '../types';

// Mock 数据
const mockNotifications: Notification[] = [
  { id: '1', userId: '1', type: 'info', message: 'test notification', read: false, createdAt: new Date() },
  { id: '2', userId: '1', type: 'warning', message: 'warning notification', read: true, createdAt: new Date() },
  { id: '3', userId: '1', type: 'alert', message: 'alert notification', read: false, createdAt: new Date() },
];

const users = { '1': 'Alice', '2': 'Bob', 'empty': 'Empty' };

export async function runList(options: ListOptions): Promise<{ output: string; error?: string }> {
  // 验证用户
  const userName = users[options.user as keyof typeof users];
  if (!userName && options.user !== 'nonexistent') {
    return { output: '', error: `用户 ${options.user} 不存在` };
  }

  if (options.user === 'nonexistent') {
    return { output: '', error: '用户不存在' };
  }

  // 过滤通知
  let list = mockNotifications.filter(n => n.userId === options.user);
  
  if (options.unread) {
    list = list.filter(n => !n.read);
  }

  if (options.user === 'empty' || list.length === 0) {
    return { output: `${userName || options.user} - 无通知` };
  }

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify({ user: options.user, notifications: list, total: list.length }, null, 2) };
  }

  // table 格式
  const lines = [`${userName} - Notifications (${options.unread ? 'unread only' : 'all'})`];
  list.forEach(n => {
    lines.push(`ID: ${n.id} | Type: ${n.type} | ${n.read ? '✓' : '○'} | ${n.message}`);
  });
  return { output: lines.join('\n') };
}