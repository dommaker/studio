// Channel Service — 频道记录读写收口（#532）
// 与 channel-message.service 同款 seam：频道记录的读（404 判定单点）与写
// （写路径内部即失效 channels 列表缓存，调用方不再感知 clearCache）。
import { randomUUID } from 'crypto';
import { logger, FileStore, type ChannelData } from '@dommaker/studio-shared';
import { clearCache } from '../../middleware/api-cache.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { getWorkspaceRecord } from '../workspaces/workspace-store.js';

/** 缓存失效键 = 路由挂载点（route-registry `/api/v1/channels`，与现状 req.baseUrl 一致） */
const CHANNELS_BASE_PATH = '/api/v1/channels';

/** 可区分的频道域错误：status 由路由层映射为 HTTP 状态码，message 即响应 error 文案 */
export class ChannelError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface CreateChannelInput {
  name: string;
  type: string;
  defaultPath: string | null;
  agents?: { name: string; description?: string | null; provider?: string }[];
  members?: string[];
}

export class ChannelService {
  private fileStore: FileStore;
  private workUnitService: WorkUnitService;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
  }

  /** 测试用：替换 FileStore 实例 */
  setFileStore(fs: FileStore): void {
    this.fileStore = fs;
    this.workUnitService = new WorkUnitService(fs);
  }

  /** #448 问题1：写后失效 channels 列表缓存（30s apiCache）。写路径内部调用，不漏。 */
  private async invalidateListCache(): Promise<void> {
    await clearCache(CHANNELS_BASE_PATH);
  }

  /** GET / 列表：全部非归档频道 */
  async listVisibleChannels(): Promise<ChannelData[]> {
    return this.fileStore.listChannels({ excludeArchived: true });
  }

  /** 404 判定单点：取不到即抛 ChannelError(404)。message 可按端点现状覆盖（chore-pmo）。 */
  async getOrThrow(id: string, message = 'Channel not found'): Promise<ChannelData> {
    const channel = await this.fileStore.getChannel(id);
    if (!channel) throw new ChannelError(message, 404);
    return channel;
  }

  /** POST / 创建（含初始 agents 创建与 members 合并）；重名抛 ChannelError(409) */
  async create(input: CreateChannelInput): Promise<ChannelData> {
    const channelName = input.name.startsWith('#') ? input.name.trim() : `#${input.name.trim()}`;
    // Check duplicate name (FileStore has no unique constraint)
    const existing = await this.fileStore.listChannels({ name: channelName });
    if (existing.length > 0) {
      throw new ChannelError('Channel name already exists', 409);
    }

    // Create channel first
    const now = new Date().toISOString();
    const channel: ChannelData = {
      id: randomUUID(),
      name: channelName,
      type: input.type,
      defaultWorkspaceId: null,
      defaultPath: input.defaultPath,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      createdAt: now,
      updatedAt: now,
    };
    await this.fileStore.createChannel(channel);

    // Create initial agents if provided
    const createdAgentIds: string[] = [];
    if (Array.isArray(input.agents) && input.agents.length > 0) {
      for (const agent of input.agents) {
        if (!agent.name || typeof agent.name !== 'string') continue;
        try {
          const profile = await this.createAgentProfile(agent.name.trim(), agent.description ?? null, channel.id, agent.provider);
          createdAgentIds.push(profile.id);
        } catch (agentErr: any) {
          // Skip duplicate agent names, continue with others
          if (!agentErr?.message?.includes('Unique constraint')) {
            logger.warn('[Channel] Failed to create agent', { agent: agent.name, error: String(agentErr) });
          }
        }
      }

      // Update channel members with created agent IDs
      if (createdAgentIds.length > 0) {
        await this.fileStore.updateChannel(channel.id, { members: JSON.stringify(createdAgentIds) });
      }
    }

    // Also include explicitly provided member IDs
    if (Array.isArray(input.members) && input.members.length > 0) {
      const allMembers = [...new Set([...createdAgentIds, ...input.members])];
      await this.fileStore.updateChannel(channel.id, { members: JSON.stringify(allMembers) });
    }

    // Reload channel to get final members
    const finalChannel = await this.getOrThrow(channel.id);
    logger.info('[Channel] Created', { id: channel.id, name: channelName, agents: createdAgentIds.length });
    await this.invalidateListCache();
    return finalChannel;
  }

  /** PATCH /:id 设置更新：routing 与存量合并（单档更新不清其他档），写后失效 */
  async update(id: string, data: Partial<ChannelData>): Promise<ChannelData> {
    const current = await this.getOrThrow(id);
    const patch = { ...data };
    if (patch.routing) {
      patch.routing = { ...(current.routing ?? {}), ...patch.routing };
    }
    await this.fileStore.updateChannel(id, patch);
    await this.invalidateListCache();
    return this.getOrThrow(id);
  }

  /** PUT /:id/archive：改名加 -archived-<ts> 后缀，写后失效。返回新名 */
  async archive(id: string): Promise<string> {
    const channel = await this.getOrThrow(id);
    const archivedName = `${channel.name}-archived-${Date.now()}`;
    await this.fileStore.updateChannel(channel.id, { name: archivedName });
    logger.info('[Channel] Archived', { channelId: channel.id, oldName: channel.name });
    await this.invalidateListCache();
    return archivedName;
  }

  /** PUT /:id/restore：去 -archived- 后缀回原名；非归档频道抛 ChannelError(400)。写后失效 */
  async restore(id: string): Promise<string> {
    const channel = await this.getOrThrow(id);
    if (!channel.name.includes('-archived-')) {
      throw new ChannelError('Channel is not archived', 400);
    }
    const restoredName = channel.name.replace(/-archived-\d+$/, '');
    await this.fileStore.updateChannel(channel.id, { name: restoredName });
    logger.info('[Channel] Restored', { channelId: channel.id, restoredName });
    await this.invalidateListCache();
    return restoredName;
  }

  /** DELETE /:id（B2-012）：无其他 rnd 频道时自建 #研发 兜底，WU 重挂后删除。写后失效 */
  async deleteWithFallback(id: string): Promise<{ fallbackChannelId: string }> {
    const channel = await this.getOrThrow(id);

    // Find or create #研发 as fallback
    const rndChannels = await this.fileStore.listChannels({ type: 'rnd' });
    let rndChannel = rndChannels.find(c => c.id !== channel.id);
    if (!rndChannel) {
      const rndId = randomUUID();
      const now = new Date().toISOString();
      rndChannel = { id: rndId, name: '#研发', type: 'rnd', defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: now, updatedAt: now };
      await this.fileStore.createChannel(rndChannel);
    }

    // Migrate WorkUnits via WorkUnitService (context.sourceChannelId in metadata)
    // 存储归属收敛：匹配（字段相等）与写入（事件+快照）均由 WorkUnitService.rebindSourceChannel 负责
    await this.workUnitService.rebindSourceChannel(channel.id, rndChannel.id);

    await this.fileStore.deleteChannel(channel.id);
    logger.info('[Channel] Deleted with fallback', { deletedId: channel.id, fallbackId: rndChannel.id });
    await this.invalidateListCache();
    return { fallbackChannelId: rndChannel.id };
  }

  /** PATCH /:id/members：add/remove 合并（幂等）后整体回写，写后失效。返回更新后 members 数组 */
  async updateMembers(
    channelId: string,
    ops: { add?: string[]; remove?: string[] },
  ): Promise<string[]> {
    const channel = await this.getOrThrow(channelId, `Channel ${channelId} not found`);

    const current: string[] = JSON.parse(channel.members);
    const addIds: string[] = ops.add ?? [];
    const removeIds: string[] = ops.remove ?? [];

    const updated = [...new Set([...current, ...addIds])].filter(id => !removeIds.includes(id));

    await this.fileStore.updateChannel(channelId, { members: JSON.stringify(updated) });
    await this.invalidateListCache();

    return updated;
  }

  /** 创建频道时的初始 agent profile 创建（name 唯一冲突复用既有 profile） */
  private async createAgentProfile(name: string, description: string | null, channelId: string, provider?: string): Promise<{ id: string }> {
    // Check name uniqueness
    const all = await this.fileStore.listProfiles();
    const existing = all.find(p => p.name === name);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const profile = {
      id: randomUUID(),
      name,
      description: description ?? null,
      channels: JSON.stringify([channelId]),
      provider: provider ?? null,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    await this.fileStore.createProfile(profile);
    return profile;
  }
}

/**
 * F6: 归一化 + 校验 defaultWorkspaceId（channel PATCH 用）。
 * '' / null / 非字符串 → null（清除默认工程）；非空字符串须对应已注册 workspace。
 */
export async function validateDefaultWorkspaceId(
  value: unknown,
): Promise<{ ok: boolean; value: string | null; error?: string }> {
  const wsId = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (wsId && !(await getWorkspaceRecord(wsId))) {
    return { ok: false, value: null, error: `Workspace not found: ${wsId}` };
  }
  return { ok: true, value: wsId };
}

export const channelService = new ChannelService();
