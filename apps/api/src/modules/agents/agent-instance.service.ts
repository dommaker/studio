/**
 * AgentInstance Service — RuntimeInstance CRUD
 *
 * AS-026: AC-1 CRUD API
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';

const VALID_STATUSES = ['idle', 'active', 'terminated'] as const;

export interface CreateInstanceInput {
  roleId: string;
  sessionId?: string;
  metadata?: string;
}

export interface UpdateInstanceInput {
  status?: string;
  currentWorkUnitId?: string | null;
  sessionId?: string | null;
  metadata?: string | null;
}

export class AgentInstanceService {

  async create(input: CreateInstanceInput) {
    return prisma.runtimeInstance.create({
      data: {
        roleId: input.roleId,
        sessionId: input.sessionId ?? null,
        status: 'idle',
        metadata: input.metadata ?? null,
      },
    });
  }

  async getById(id: string) {
    return prisma.runtimeInstance.findUnique({ where: { id } });
  }

  async list(options?: { status?: string; page?: number; limit?: number }) {
    const { status, page = 1, limit = 20 } = options ?? {};
    const where: Prisma.RuntimeInstanceWhereInput = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.runtimeInstance.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { startedAt: 'desc' },
      }),
      prisma.runtimeInstance.count({ where }),
    ]);

    return { data, total };
  }

  async update(id: string, input: UpdateInstanceInput) {
    if (input.status !== undefined && !(VALID_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`Invalid status: ${input.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const data: Prisma.RuntimeInstanceUncheckedUpdateInput = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.currentWorkUnitId !== undefined) data.currentWorkUnitId = input.currentWorkUnitId;
    if (input.sessionId !== undefined) data.sessionId = input.sessionId;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    return prisma.runtimeInstance.update({ where: { id }, data });
  }
}
