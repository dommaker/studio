// Channel API — B1-001 + Phase 2 (AC-B4/C3/E3)
import { api } from './index';

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorType: 'human' | 'agent';
  agentName?: string;
  content: string;
  replyToId?: string | null;
  workUnitId?: string | null;
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
  isOnline?: boolean;
}

export interface ConvertSuggestion {
  title?: string;
  description?: string;
  suggestedAssigneeId?: string;
  suggestedProjectPath?: string;
}

export interface LocalProject {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  language?: string;
}

export const channelApi = {
  list: () =>
    api.get<{ success: boolean; data: Channel[] }>('/channels'),

  update: (channelId: string, data: { defaultWorkspaceId?: string; defaultPath?: string; name?: string }) =>
    api.patch<{ success: boolean; data: Channel }>(`/channels/${channelId}`, data),

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

  listAgents: (channelId?: string) =>
    api.get<{ data: AgentProfile[]; pagination: { total: number } }>('/agent-profiles', {
      params: { status: 'active', ...(channelId ? { channelId } : {}) },
    }),

  convertToTask: (channelId: string, messageId: string, data: {
    title?: string; description?: string; assigneeId?: string; projectPath?: string;
  }) =>
    api.post<{ success: boolean; data: unknown }>(
      `/channels/${channelId}/messages/${messageId}/convert-to-task`,
      data
    ),

  suggestTask: (channelId: string, messageId: string) =>
    api.post<{ success: boolean; data: ConvertSuggestion }>(
      `/channels/${channelId}/messages/${messageId}/convert-to-task/suggest`
    ),

  discoverProjects: (search?: string) => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    return api.get<{ success: boolean; data: LocalProject[] }>(`/projects/discover${params}`);
  },
};
