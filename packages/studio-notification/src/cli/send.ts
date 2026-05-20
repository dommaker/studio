import type { SendOptions, Notification } from '../types';

// Mock 数据存储
const notifications: Notification[] = [];
const users = { '1': 'Alice', '2': 'Bob', 'empty': 'Empty' };

const validTypes = ['info', 'warning', 'alert'] as const;

export async function runSend(options: SendOptions): Promise<{ output: string; error?: string }> {
  // 验证消息
  if (!options.message || options.message.trim() === '') {
    return { output: '', error: '消息内容不能为空' };
  }

  // 验证类型
  if (!validTypes.includes(options.type)) {
    return { output: '', error: `无效类型: ${options.type}，应为 info/warning/alert` };
  }

  // 验证用户
  const userName = users[options.to as keyof typeof users];
  if (!userName) {
    return { output: '', error: `用户 ${options.to} 不存在` };
  }

  // 创建通知
  const notification: Notification = {
    id: `notif-${Date.now()}`,
    userId: options.to,
    type: options.type,
    message: options.message,
    read: false,
    createdAt: new Date()
  };
  notifications.push(notification);

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify(notification, null, 2) };
  }

  // table 格式
  return { output: `Notification sent to ${userName} (ID: ${notification.id})\nType: ${notification.type}\nMessage: ${notification.message}` };
}