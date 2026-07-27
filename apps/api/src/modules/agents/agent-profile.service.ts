/**
 * AgentProfile Service — 简化 Agent 身份 CRUD
 *
 * AS-025 Phase 2: name + description + channels
 * Storage: FileStore (迁移自 Prisma)
 */

import { randomUUID } from 'crypto';
import { eventBus, FileStore, parseChannels, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';

/** 保留角色名：系统内置 studio 角色专用，用户不可创建/改名/删除 */
export const STUDIO_ROLE_NAME = 'studio';

/** B4a: studio 角色定位描述（种子默认值；用户自定义后不覆盖） */
export const STUDIO_ROLE_DESCRIPTION = '系统角色：平台维护性 LLM 调用与系统提醒署名，不执行任务';

export interface CreateAgentProfileInput {
  name: string;
  description?: string;
  channels?: string[];
  provider?: string;
  status?: string;
}

export interface UpdateAgentProfileInput {
  name?: string;
  description?: string | null;
  channels?: string[];
  provider?: string | null;
  status?: string;
}

export type AgentProfileWithOnline = AgentProfileData & {
  isOnline: boolean;
  /** F2: 最近一次启动失败原因（health probe 等），来自 runtime state */
  lastError: string | null;
  lastErrorAt: string | null;
};

/**
 * AC-1.1: 幂等创建内置 studio 角色。
 *
 * studio 角色是系统任务执行身份（systemExecutor 读其 provider），
 * 不通过 AgentProfileService.create 走事件流（避免触发 agentLoopRegistry mount），
 * 直接 fileStore.createProfile。已存在则跳过。
 *
 * B4a: description 定位为"系统角色不执行任务"——新建直接写入；
 * 存量仅在 description 为空（旧默认）时回填，用户自定义不覆盖。
 */
export async function ensureStudioProfile(fileStore: FileStore): Promise<AgentProfileData> {
  const all = await fileStore.listProfiles();
  const existing = all.find(p => p.name === STUDIO_ROLE_NAME);
  if (existing) {
    if (!existing.description || !existing.description.trim()) {
      await fileStore.updateProfile(existing.id, { description: STUDIO_ROLE_DESCRIPTION });
      return { ...existing, description: STUDIO_ROLE_DESCRIPTION };
    }
    return existing;
  }

  const now = new Date().toISOString();
  const data: AgentProfileData = {
    id: randomUUID(),
    name: STUDIO_ROLE_NAME,
    description: STUDIO_ROLE_DESCRIPTION,
    channels: '[]',
    provider: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await fileStore.createProfile(data);
  // 故意不发 agent-profile.created 事件：studio 角色 mount 应跳过（AC-1.3），
  // 走事件流会触发 mount，虽 mount 内部会跳过，但事件语义不对（不是用户创建）。
  return data;
}

export class AgentProfileService {
  constructor(
    private fileStore: FileStore,
  ) {}

  async create(input: CreateAgentProfileInput): Promise<AgentProfileData> {
    // AC-1.2: 保留名拒绝
    if (input.name === STUDIO_ROLE_NAME) {
      throw new Error(`name "${STUDIO_ROLE_NAME}" is reserved for system role`);
    }

    // Check name uniqueness by scanning all profiles
    const all = await this.fileStore.listProfiles();
    if (all.some(p => p.name === input.name)) {
      throw new Error(`Unique constraint: AgentProfile with name "${input.name}" already exists`);
    }

    const now = new Date().toISOString();
    const data: AgentProfileData = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      channels: stringifyChannels(input.channels),
      provider: input.provider ?? null,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.fileStore.createProfile(data);
    // F1: notify AgentLoopRegistry (mounts a loop when created already active)
    eventBus.publish('agent-profile.created', { profile: data });
    return data;
  }

  async getById(id: string): Promise<AgentProfileData | null> {
    return this.fileStore.getProfile(id);
  }

  async getByName(name: string): Promise<AgentProfileData | null> {
    const all = await this.fileStore.listProfiles();
    return all.find(p => p.name === name) ?? null;
  }

  async list(options?: {
    status?: string;
    channelId?: string;
    provider?: string;
    page?: number;
    limit?: number;
    /** AC-1.4: 默认排除 studio 角色；true 时包含 */
    includeSystem?: boolean;
  }): Promise<{ data: AgentProfileWithOnline[]; total: number }> {
    const { status, channelId, provider, page = 1, limit = 20, includeSystem = false } = options ?? {};

    let profiles = await this.fileStore.listProfiles(status ? { status } : undefined);

    // AC-1.4: 默认排除 studio 角色（系统内置，不面向用户）
    if (!includeSystem) {
      profiles = profiles.filter(p => p.name !== STUDIO_ROLE_NAME);
    }

    // When filtering by channelId, fetch all (no pagination) to avoid missing members across pages
    const fetchAll = !!channelId;

    // Filter by channelId (Channel.members contains AgentProfile IDs)
    if (channelId) {
      const channel = await this.fileStore.getChannel(channelId);
      const memberIds: string[] = channel?.members ? JSON.parse(channel.members) : [];
      if (memberIds.length > 0) {
        profiles = profiles.filter(p => memberIds.includes(p.id));
      }
      // Fallback: if channel has no members configured, return all (empty members fallback)
    }

    // Filter by provider (exact match; null matches only null-provider profiles)
    if (provider !== undefined) {
      profiles = profiles.filter(p => p.provider === provider);
    }

    // Add isOnline field (check RuntimeState via FileStore)
    // Online 语义 = loop 存活：status idle/active 且心跳新鲜（刚启动未及首次心跳时按 startedAt 宽限）。
    // 阈值与 agent-timeout-scan 一致（5 分钟）— 空闲 loop 不再误显示为离线。
    const ONLINE_TIMEOUT_MS = 5 * 60 * 1000;
    const onlineThreshold = Date.now() - ONLINE_TIMEOUT_MS;
    const agentIds = profiles.map(p => p.id);
    const allStates = await this.fileStore.listStates();
    const aliveStates = allStates.filter(s =>
      (s.status === 'active' || s.status === 'idle') && agentIds.includes(s.roleId) &&
      (s.lastHeartbeat
        ? new Date(s.lastHeartbeat).getTime() >= onlineThreshold
        : new Date(s.startedAt).getTime() >= onlineThreshold)
    );
    const onlineSet = new Set(aliveStates.map(ri => ri.roleId));

    // F2: surface latest startup failure per profile (status === 'error' states only)
    const errorByRole = new Map<string, { lastError: string; lastErrorAt: string | null }>();
    for (const s of allStates) {
      if (s.status !== 'error' || !s.lastError || !agentIds.includes(s.roleId)) continue;
      const prev = errorByRole.get(s.roleId);
      if (!prev || (s.lastErrorAt ?? '') > (prev.lastErrorAt ?? '')) {
        errorByRole.set(s.roleId, { lastError: s.lastError, lastErrorAt: s.lastErrorAt ?? null });
      }
    }

    const data: AgentProfileWithOnline[] = profiles.map(p => ({
      ...p,
      isOnline: onlineSet.has(p.id),
      lastError: errorByRole.get(p.id)?.lastError ?? null,
      lastErrorAt: errorByRole.get(p.id)?.lastErrorAt ?? null,
    }));

    // Sort by createdAt descending (same as Prisma orderBy: { createdAt: 'desc' })
    data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = channelId ? data.length : profiles.length;

    // Apply pagination
    if (!fetchAll) {
      const start = (page - 1) * limit;
      const paged = data.slice(start, start + limit);
      return { data: paged, total };
    }

    return { data, total };
  }

  async update(id: string, input: UpdateAgentProfileInput): Promise<AgentProfileData> {
    const existing = await this.fileStore.getProfile(id);
    if (!existing) throw new Error(`AgentProfile not found: ${id}`);

    // AC-1.2: 拒绝改名到 studio
    if (input.name === STUDIO_ROLE_NAME) {
      throw new Error(`name "${STUDIO_ROLE_NAME}" is reserved for system role`);
    }

    const patch: Partial<AgentProfileData> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.channels !== undefined) patch.channels = stringifyChannels(input.channels);
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.status !== undefined) patch.status = input.status;

    await this.fileStore.updateProfile(id, patch);
    const updated = await this.fileStore.getProfile(id);
    if (!updated) throw new Error(`AgentProfile not found: ${id}`);

    // F1: status transition (activate/deactivate) → AgentLoopRegistry mount/unmount
    if (existing.status !== updated.status) {
      eventBus.publish('agent-profile.updated', { profile: updated, previousStatus: existing.status });
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    // AC-1.5: 拒绝删除 studio 角色
    const existing = await this.fileStore.getProfile(id);
    if (existing?.name === STUDIO_ROLE_NAME) {
      throw new Error(`studio role cannot be deleted`);
    }

    await this.fileStore.deleteProfile(id);
    // 清理 channel.members 中的悬空引用（channel.members 是成员关系唯一事实源）
    const channels = await this.fileStore.listChannels();
    for (const ch of channels) {
      const ids = parseChannels(ch.members);
      if (ids.includes(id)) {
        await this.fileStore.updateChannel(ch.id, {
          members: JSON.stringify(ids.filter(m => m !== id)),
        });
      }
    }
    // F1: notify AgentLoopRegistry (unmounts the loop)
    eventBus.publish('agent-profile.deleted', { profileId: id });
  }
}
