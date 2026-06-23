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
    page?: number;
    limit?: number;
  }): Promise<{ data: AgentProfile[]; total: number }> {
    const { status, page = 1, limit = 20 } = options ?? {};
    const where: Prisma.AgentProfileWhereInput = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.agentProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.agentProfile.count({ where }),
    ]);

    return { data, total };
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
