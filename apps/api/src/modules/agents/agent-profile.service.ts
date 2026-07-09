/**
 * AgentProfile Service — 简化 Agent 身份 CRUD
 *
 * AS-025 Phase 2: name + description + channels
 */

import { Prisma, type AgentProfile } from '@prisma/client';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';

export interface CreateAgentProfileInput {
  name: string;
  description?: string;
  channels?: string[];
  status?: string;
}

export interface UpdateAgentProfileInput {
  name?: string;
  description?: string | null;
  channels?: string[];
  status?: string;
}

export class AgentProfileService {
  constructor(private prisma: ExtendedPrismaClient) {}

  async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    return this.prisma.agentProfile.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        channels: input.channels ? JSON.stringify(input.channels) : '[]',
        status: input.status ?? 'active',
      },
    });
  }

  async getById(id: string): Promise<AgentProfile | null> {
    return this.prisma.agentProfile.findUnique({ where: { id } });
  }

  async getByName(name: string): Promise<AgentProfile | null> {
    return this.prisma.agentProfile.findUnique({ where: { name } });
  }

  async list(options?: {
    status?: string;
    channelId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: Array<AgentProfile & { isOnline: boolean }>; total: number }> {
    const { status, channelId, page = 1, limit = 20 } = options ?? {};
    const where: Prisma.AgentProfileWhereInput = {};
    if (status) where.status = status;

    // When filtering by channelId, fetch all (no pagination) to avoid missing members across pages
    const fetchAll = !!channelId;

    const [rawData, total] = await Promise.all([
      this.prisma.agentProfile.findMany({
        where,
        ...(fetchAll ? {} : { skip: (page - 1) * limit, take: limit }),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.agentProfile.count({ where }),
    ]);

    // Filter by channelId (Channel.members contains AgentProfile IDs)
    let filtered = rawData;
    if (channelId) {
      // Query canonical source: Channel.members (written by PATCH /channels/:id/members)
      const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
      const memberIds: string[] = channel?.members ? JSON.parse(channel.members) : [];
      if (memberIds.length > 0) {
        filtered = rawData.filter(p => memberIds.includes(p.id));
      }
      // Fallback: if channel has no members configured, return all (empty members fallback)
    }

    // Add isOnline field (check RuntimeInstance)
    const agentIds = filtered.map(p => p.id);
    const activeInstances = await this.prisma.runtimeInstance.findMany({
      where: { roleId: { in: agentIds }, status: 'active' },
      select: { roleId: true },
    });
    const onlineSet = new Set(activeInstances.map(ri => ri.roleId));

    const data = filtered.map(p => ({
      ...p,
      isOnline: onlineSet.has(p.id),
    }));

    return { data, total: channelId ? filtered.length : total };
  }

  async update(id: string, input: UpdateAgentProfileInput): Promise<AgentProfile> {
    const data: Prisma.AgentProfileUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.channels !== undefined) data.channels = JSON.stringify(input.channels);
    if (input.status !== undefined) data.status = input.status;

    return this.prisma.agentProfile.update({ where: { id }, data });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.agentProfile.delete({ where: { id } });
  }
}
