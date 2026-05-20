// Channel API — B1-001
import { api } from './index';

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorType: 'human' | 'agent';
  agentName?: string;
  content: string;
  replyToId?: string;
  meta?: string;
  createdAt: string;
}

export const channelApi = {
  listMessages: (channelId: string, params?: { before?: string; limit?: number }) =>
    api.get<{ success: boolean; data: ChannelMessage[]; total: number; hasMore: boolean }>(
      `/channels/${channelId}/messages`,
      { params }
    ),

  sendMessage: (channelId: string, content: string, replyToId?: string) =>
    api.post<{ success: boolean; data: ChannelMessage & { analystTriggered: boolean } }>(
      `/channels/${channelId}/messages`,
      { content, replyToId }
    ),

  sendAction: (channelId: string, messageId: string, action: string) =>
    api.post(`/channels/${channelId}/messages/${messageId}/actions`, { action }),
};
