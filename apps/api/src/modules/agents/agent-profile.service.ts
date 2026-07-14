/**
 * AgentProfile Service — 简化 Agent 身份 CRUD
 *
 * AS-025 Phase 2: name + description + channels
 * Storage: FileStore (迁移自 Prisma)
 */

import { randomUUID } from 'crypto';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';

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

export type AgentProfileWithOnline = AgentProfileData & { isOnline: boolean };

export class AgentProfileService {
  constructor(
    private fileStore: FileStore,
    private prisma: ExtendedPrismaClient,
  ) {}

  async create(input: CreateAgentProfileInput): Promise<AgentProfileData> {
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
      channels: input.channels ? JSON.stringify(input.channels) : '[]',
      provider: input.provider ?? null,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.fileStore.createProfile(data);
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
  }): Promise<{ data: AgentProfileWithOnline[]; total: number }> {
    const { status, channelId, provider, page = 1, limit = 20 } = options ?? {};

    let profiles = await this.fileStore.listProfiles(status ? { status } : undefined);

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
    const agentIds = profiles.map(p => p.id);
    const allStates = await this.fileStore.listStates();
    const activeStates = allStates.filter(s => s.status === 'active' && agentIds.includes(s.roleId));
    const onlineSet = new Set(activeStates.map(ri => ri.roleId));

    const data: AgentProfileWithOnline[] = profiles.map(p => ({
      ...p,
      isOnline: onlineSet.has(p.id),
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
    const patch: Partial<AgentProfileData> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.channels !== undefined) patch.channels = JSON.stringify(input.channels);
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.status !== undefined) patch.status = input.status;

    await this.fileStore.updateProfile(id, patch);
    const updated = await this.fileStore.getProfile(id);
    if (!updated) throw new Error(`AgentProfile not found: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.fileStore.deleteProfile(id);
  }
}
