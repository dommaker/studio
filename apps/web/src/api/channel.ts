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

export interface Channel {
  id: string;
  name: string;
  type: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

export const channelApi = {
  list: () =>
    api.get<{ success: boolean; data: Channel[] }>('/channels'),

  listMessages: (channelId: string, params?: { before?: string; limit?: number }) =>
    api.get<{ success: boolean; data: ChannelMessage[]; total: number; hasMore: boolean }>(
      `/channels/${channelId}/messages`,
      { params }
    ),

  sendMessage: (channelId: string, content: string, replyToId?: string) =>
    api.post<{ success: boolean; data: ChannelMessage }>(
      `/channels/${channelId}/messages`,
      { content, replyToId }
    ),

  listAgents: () =>
    api.get<{ data: AgentProfile[]; pagination: { total: number } }>('/agent-profiles', {
      params: { status: 'active' },
    }),
};
