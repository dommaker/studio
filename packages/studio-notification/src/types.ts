export interface Notification {
  id: string;
  userId: string;
  type: 'info' | 'warning' | 'alert';
  message: string;
  read: boolean;
  createdAt: Date;
}

export interface SendOptions {
  to: string;
  type: 'info' | 'warning' | 'alert';
  message: string;
  format?: 'table' | 'json';
}

export interface ListOptions {
  user: string;
  unread?: boolean;
  format?: 'table' | 'json';
}

export interface MarkOptions {
  notification: string;
  all?: boolean;
  format?: 'table' | 'json';
}