import type { MarkOptions, Notification } from '../types';

// Mock 数据
const mockNotifications: Notification[] = [
  { id: '1', userId: '1', type: 'info', message: 'test notification', read: false, createdAt: new Date() },
  { id: '2', userId: '1', type: 'info', message: 'test notification 2', read: false, createdAt: new Date() },
  { id: 'already-read', userId: '1', type: 'info', message: 'already read', read: true, createdAt: new Date() },
];

export async function runMark(options: MarkOptions): Promise<{ output: string; error?: string }> {
  // 批量标记
  if (options.all) {
    const unreadCount = mockNotifications.filter(n => !n.read).length;
    mockNotifications.forEach(n => n.read = true);
    const format = options.format || 'table';
    if (format === 'json') {
      return { output: JSON.stringify({ marked: unreadCount, status: 'read' }, null, 2) };
    }
    return { output: `All ${unreadCount} notifications marked as read` };
  }

  // 单个标记
  const notification = mockNotifications.find(n => n.id === options.notification);
  
  if (!notification) {
    return { output: '', error: '通知不存在' };
  }

  if (notification.read) {
    return { output: `Notification ${options.notification} already read` };
  }

  notification.read = true;

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify({ notificationId: options.notification, status: 'read' }, null, 2) };
  }

  return { output: `Notification ${options.notification} marked as read` };
}