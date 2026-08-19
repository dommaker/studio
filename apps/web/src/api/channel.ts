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
  /** #264：REST/SSE 出口为 object（shapeMessageData 已解析）；string 为存量/测试形态，消费侧双型兼容 */
  meta?: string | Record<string, unknown>;
  createdAt: string;
}

export interface Channel {
  id: string;
  name: string;
  type: string;
  defaultWorkspaceId?: string | null;
  defaultPath?: string | null;
  members?: string; // JSON string of agent ID array
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string | null;
  status: string;
  provider?: string | null;
  channels?: string | string[] | null; // JSON string of channel ID array（历史数据可能双重编码）
  isOnline?: boolean;
  lastError?: string | null;
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

  get: (channelId: string) =>
    api.get<{ success: boolean; data: Channel }>(`/channels/${channelId}`),

  create: (data: { name: string; type: string; agents?: Array<{ name: string }> }) =>
    api.post<{ success: boolean; data: Channel }>('/channels', data),

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

  listAgents: (channelId?: string, options?: { includeSystem?: boolean }) =>
    api.get<{ data: AgentProfile[]; pagination: { total: number } }>('/agent-profiles', {
      params: {
        status: 'active',
        ...(channelId ? { channelId } : {}),
        ...(options?.includeSystem ? { includeSystem: 'true' } : {}),
      },
    }),

  /** 管理列表用：全量 profile（含 studio 系统角色与 inactive），不带 status 过滤 */
  listAllAgents: () =>
    api.get<{ data: AgentProfile[]; pagination: { total: number } }>('/agent-profiles', {
      params: { includeSystem: 'true', limit: 200 },
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

  updateMembers: (channelId: string, ops: { add?: string[]; remove?: string[] }) =>
    api.patch<{ success: boolean; data: { members: string[] } }>(`/channels/${channelId}/members`, ops),

  createAgent: (data: { name: string; description?: string; channels?: string[]; provider?: string }) =>
    api.post<AgentProfile>('/agent-profiles', data),

  updateAgent: (id: string, data: Partial<{ name: string; description: string | null; channels: string[]; provider: string | null; status: string }>) =>
    api.patch<AgentProfile>(`/agent-profiles/${id}`, data),
};
