// Channel API — B1-001 + Phase 2 (AC-B4/C3/E3)
// 契约驱动迁移（2026-09 批次 1/7）：channels 域类型 import 自 @dommaker/studio-contract，
// 响应壳统一 { data }（原 {success,data} 手抄声明删除）；消息分页 { data:{messages,total,hasMore} }。
// 契约驱动迁移（2026-10 批次 8/8）：agent-profiles 域类型（AgentProfile/AgentProfileListItem/
// RolePresetSummary）改 contract import（本地手抄 interface 删除）；createAgent/updateAgent
// 响应统一 `{ data }` 壳（原裸实体），消费方解包 res.data → res.data.data。
import type {
  Channel,
  ChannelRouting,
  FileRef,
  ChannelFileVocabulary,
  ChannelCurrentPmo,
  ChannelPmoCandidate,
  ChannelSuggestions,
  MergeTargetPreview,
  ConvertSuggestion,
  ChannelMessagesResult,
  SavedImage,
  SendIntent,
  LocalProject,
  AgentProfile,
  AgentProfileListItem,
  RolePresetSummary,
} from '@dommaker/studio-contract';
import { api } from './index';
import type { ChannelMessage } from '../types/channel';

export type {
  Channel,
  ChannelRouting,
  FileRef,
  ChannelFileVocabulary,
  ChannelCurrentPmo,
  ChannelPmoCandidate,
  ChannelSuggestions,
  MergeTargetPreview,
  ConvertSuggestion,
};
export type { ChannelSuggestion, SendIntent, LocalProject, AgentProfile, AgentProfileListItem, RolePresetSummary } from '@dommaker/studio-contract';

/** 频道消息 = 契约 wire 形状 + 客户端本地标记（#326 骨架降级 / #486 乐观回显，服务端不下发）。
 *  P3-a：定义迁至 src/types/channel.ts（api 层不声明导出类型），此处仅 re-export。 */
export type { ChannelMessage };

export const channelApi = {
  list: () =>
    api.get<{ data: Channel[] }>('/channels'),

  get: (channelId: string) =>
    api.get<{ data: Channel }>(`/channels/${channelId}`),

  create: (data: { name: string; type: string; agents?: Array<{ name: string }>; defaultPath?: string | null }) =>
    api.post<{ data: Channel }>('/channels', data),

  update: (channelId: string, data: { defaultWorkspaceId?: string; defaultPath?: string; name?: string; routing?: ChannelRouting }) =>
    api.patch<{ data: Channel }>(`/channels/${channelId}`, data),

  listMessages: (channelId: string, params?: { before?: string; limit?: number }) =>
    // 响应里的 total 后端 2026-09 起恒 0（默认跳过节流扫描，?includeTotal=true 才实算）且前端无消费方
    api.get<{ data: ChannelMessagesResult }>(
      `/channels/${channelId}/messages`,
      { params }
    ),

  sendMessage: (channelId: string, content: string, replyToId?: string, files?: FileRef[], intent?: SendIntent) =>
    api.post<{ data: ChannelMessage }>(
      `/channels/${channelId}/messages`,
      { content, replyToId, ...(files?.length ? { files } : {}), ...(intent ? { intent } : {}) }
    ),

  /** #632: 发送前归属预览（无 @ 无 replyTo 消息的 merge 预测；失败由调用方静默降级为不显示预览条） */
  getMergeTarget: (channelId: string) =>
    api.get<{ data: MergeTargetPreview }>(`/channels/${channelId}/merge-target`),

  /** #281: @文件引用只读词表（候选集 = 频道相关工程；文件候选走词表路径后缀补全） */
  getFileVocabulary: (channelId: string) =>
    api.get<{ data: ChannelFileVocabulary }>(`/channels/${channelId}/file-vocabulary`),

  /** 2026-09 截图粘贴：频道图片上传（JSON base64；返回相对 URL，渲染时现拼 ?token=） */
  uploadAttachment: (channelId: string, data: { mime: string; dataBase64: string }) =>
    api.post<{ data: SavedImage }>(
      `/channels/${channelId}/attachments`,
      data,
    ),

  /** #272: 顶栏「当前 PMO」chip 派生（最近挂接 REQ 所属 PMO / 杂务 PMO；无 → data=null） */
  getCurrentPmo: (channelId: string) =>
    api.get<{ data: ChannelCurrentPmo | null }>(`/channels/${channelId}/current-pmo`),

  /** #638: `#` 触发 PMO 自动补全候选（当前 PMO 置顶 + 挂接 REQ 所属 PMO；无来源 → data=[]） */
  getPmoCandidates: (channelId: string) =>
    api.get<{ data: ChannelPmoCandidate[] }>(`/channels/${channelId}/pmo-candidates`),

  /** #443: 频道建议派生（fail-closed，按当前事实现算；无建议 → suggestions=[]） */
  getSuggestions: (channelId: string) =>
    api.get<{ data: ChannelSuggestions }>(`/channels/${channelId}/suggestions`),

  listAgents: (channelId?: string, options?: { includeSystem?: boolean }) =>
    api.get<{ data: AgentProfileListItem[]; pagination: { total: number } }>('/agent-profiles', {
      params: {
        status: 'active',
        ...(channelId ? { channelId } : {}),
        ...(options?.includeSystem ? { includeSystem: 'true' } : {}),
      },
    }),

  /** 管理列表用：全量 profile（含 studio 系统角色与 inactive），不带 status 过滤 */
  listAllAgents: () =>
    api.get<{ data: AgentProfileListItem[]; pagination: { total: number } }>('/agent-profiles', {
      params: { includeSystem: 'true', limit: 200 },
    }),

  convertToTask: (channelId: string, messageId: string, data: {
    title?: string; description?: string; assigneeId?: string; projectPath?: string;
  }) =>
    api.post<{ data: unknown }>(
      `/channels/${channelId}/messages/${messageId}/convert-to-task`,
      data
    ),

  suggestTask: (channelId: string, messageId: string) =>
    api.post<{ data: ConvertSuggestion }>(
      `/channels/${channelId}/messages/${messageId}/convert-to-task/suggest`
    ),

  discoverProjects: (search?: string) => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    // 契约驱动迁移（批次 2/7）：{ success, data } 平铺壳 → { data }
    return api.get<{ data: LocalProject[] }>(`/projects/discover${params}`);
  },

  updateMembers: (channelId: string, ops: { add?: string[]; remove?: string[] }) =>
    api.patch<{ data: { members: string[]; warning?: string } }>(`/channels/${channelId}/members`, ops),

  createAgent: (data: { name: string; description?: string; channels?: string[]; provider?: string; skills?: string[]; preset?: string }) =>
    api.post<{ data: AgentProfile }>('/agent-profiles', data),

  updateAgent: (id: string, data: Partial<{ name: string; description: string | null; channels: string[]; provider: string | null; status: string; skills: string[]; persona: string | null; acceptedTypes: string[] }>) =>
    api.patch<{ data: AgentProfile }>(`/agent-profiles/${id}`, data),

  /** #633（ADR 2026-09-23-role-preset-surface）：角色 preset 清单——RoleFormModal「从模板开始」数据源（服务端扫 .agents/roles/，不硬编码） */
  listRolePresets: () =>
    api.get<{ data: RolePresetSummary[] }>('/agent-profiles/presets'),

  /** #630（ADR 2026-09-23 决策 5）：删除角色（204；服务端级联清频道成员与路由指名、卸载 loop，studio 角色服务端拒删） */
  deleteAgent: (id: string) =>
    api.delete<void>(`/agent-profiles/${id}`),
};
