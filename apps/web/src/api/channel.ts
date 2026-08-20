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

/** #281（决策 #249 §2）：@文件引用——repo = 工程绝对路径（PMO gitRepos 同形），path = git ls-files 相对路径 */
export interface FileRef {
  repo: string;
  path: string;
}

/** #281：频道文件词表（候选集顺序，各仓 git ls-files） */
export interface ChannelFileVocabulary {
  repos: { repo: string; files: string[] }[];
}

/** #272（决策 #251 Q6）：顶栏「当前 PMO」chip 形状（派生不落库；gitRepos 多仓走 tooltip） */
export interface ChannelCurrentPmo {
  id: string;
  pmoNumber: string;
  title: string;
  gitRepos: string[];
}

export const channelApi = {
  list: () =>
    api.get<{ success: boolean; data: Channel[] }>('/channels'),

  get: (channelId: string) =>
    api.get<{ success: boolean; data: Channel }>(`/channels/${channelId}`),

  create: (data: { name: string; type: string; agents?: Array<{ name: string }>; defaultPath?: string | null }) =>
    api.post<{ success: boolean; data: Channel }>('/channels', data),

  update: (channelId: string, data: { defaultWorkspaceId?: string; defaultPath?: string; name?: string }) =>
    api.patch<{ success: boolean; data: Channel }>(`/channels/${channelId}`, data),

  listMessages: (channelId: string, params?: { before?: string; limit?: number }) =>
    api.get<{ success: boolean; data: ChannelMessage[]; total: number; hasMore: boolean }>(
      `/channels/${channelId}/messages`,
      { params }
    ),

  sendMessage: (channelId: string, content: string, replyToId?: string, files?: FileRef[]) =>
    api.post<{ success: boolean; data: ChannelMessage }>(
      `/channels/${channelId}/messages`,
      { content, replyToId, ...(files?.length ? { files } : {}) }
    ),

  /** #281: @文件引用只读词表（候选集 = 频道相关工程；文件候选走词表路径后缀补全） */
  getFileVocabulary: (channelId: string) =>
    api.get<{ success: boolean; data: ChannelFileVocabulary }>(`/channels/${channelId}/file-vocabulary`),

  /** #272: 顶栏「当前 PMO」chip 派生（最近挂接 REQ 所属 PMO / 杂务 PMO；无 → data=null） */
  getCurrentPmo: (channelId: string) =>
    api.get<{ success: boolean; data: ChannelCurrentPmo | null }>(`/channels/${channelId}/current-pmo`),

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

  /** #278（决策 #250 D2）：auditor_suggestion 卡人审决策（采纳建本频道未指派 task 工单；拒绝仅留痕） */
  cardDecision: (channelId: string, messageId: string, decision: 'confirm' | 'reject') =>
    api.post<{ success: boolean; data: { status: 'confirmed' | 'rejected'; workUnitId?: string } }>(
      `/channels/${channelId}/messages/${messageId}/card-decision`,
      { decision }
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
