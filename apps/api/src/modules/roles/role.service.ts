/**
 * Role Service — 角色管理
 *
 * 负责角色的 CRUD、workflow 管理、项目负责人管理
 */

import { Prisma, Role } from '@prisma/client';
import { PrismaClient, prisma } from '@dommaker/studio-prisma';
import { logger, LEVEL_CONFIG } from '@dommaker/studio-shared';

export interface CreateRoleInput {
  name: string;
  type: string;
  avatar?: string;
  companyId: string;
  workflows?: string[];
}

export interface UpdateRoleInput {
  name?: string;
  avatar?: string;
  status?: string;
  workflows?: string[];
}

export interface RoleWithCapabilities extends Omit<Role, 'workflows'> {
  workflows: string[];
}

export class RoleService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateRoleInput): Promise<RoleWithCapabilities> {
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        type: input.type,
        avatar: input.avatar,
        companyId: input.companyId,
        workflows: JSON.stringify(input.workflows ?? []),
      },
    });

    return this.getById(role.id) as Promise<RoleWithCapabilities>;
  }

  async getById(roleId: string): Promise<RoleWithCapabilities | null> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) return null;

    return {
      ...role,
      workflows: role.workflows ? JSON.parse(role.workflows) as string[] : [],
    };
  }

  async list(options?: {
    companyId?: string;
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: Role[]; total: number }> {
    const { companyId, type, status, page = 1, limit = 20 } = options || {};

    const where: Prisma.RoleWhereInput = {};
    if (companyId) where.companyId = companyId;
    if (type) where.type = type;
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.role.count({ where }),
    ]);

    return { data, total };
  }

  async update(roleId: string, input: UpdateRoleInput): Promise<Role> {
    const updateData: Prisma.RoleUpdateInput = {
      name: input.name,
      avatar: input.avatar,
      status: input.status,
      updatedAt: new Date(),
    };

    if (input.workflows !== undefined) {
      updateData.workflows = JSON.stringify(input.workflows);
    }

    return this.prisma.role.update({
      where: { id: roleId },
      data: updateData,
    });
  }

  async delete(roleId: string): Promise<void> {
    await this.prisma.role.delete({
      where: { id: roleId },
    });
  }

  getLevelConfig() {
    return LEVEL_CONFIG;
  }

  // ============================================
  // Workflows
  // ============================================

  async addWorkflows(roleId: string, workflowIds: string[]): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) throw new Error('Role not found');

    const currentWorkflows = role.workflows || [];
    const newWorkflows = [...new Set([...currentWorkflows, ...workflowIds])];

    await this.prisma.role.update({
      where: { id: roleId },
      data: { workflows: JSON.stringify(newWorkflows) },
    });

    logger.info(`Added ${workflowIds.length} workflows to role ${roleId}`);
  }

  async removeWorkflow(roleId: string, workflowId: string): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) throw new Error('Role not found');

    const newWorkflows = (role.workflows || []).filter(w => w !== workflowId);

    await this.prisma.role.update({
      where: { id: roleId },
      data: { workflows: JSON.stringify(newWorkflows) },
    });
  }

  async hasWorkflow(roleId: string, workflowId: string): Promise<boolean> {
    const role = await this.getById(roleId);
    if (!role) return false;
    return role.workflows.includes(workflowId);
  }

  // ============================================
  // Project lead
  // ============================================

  async getProjectLead(companyId: string): Promise<RoleWithCapabilities | null> {
    const candidates = await this.prisma.role.findMany({
      where: {
        companyId,
        status: 'active',
        OR: [
          { isProjectLead: true },
          { type: 'tech-lead' },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const projectLead = candidates.find(r => r.isProjectLead);
    if (projectLead) return this.getById(projectLead.id);

    const techLead = candidates.find(r => r.type === 'tech-lead');
    if (techLead) return this.getById(techLead.id);

    const anyActive = await this.prisma.role.findFirst({
      where: { companyId, status: 'active' },
    });
    return anyActive ? this.getById(anyActive.id) : null;
  }

  async setProjectLead(roleId: string, isProjectLead: boolean): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) throw new Error('Role not found');

    if (isProjectLead) {
      await this.prisma.role.updateMany({
        where: { companyId: role.companyId, isProjectLead: true },
        data: { isProjectLead: false },
      });
    }

    await this.prisma.role.update({
      where: { id: roleId },
      data: { isProjectLead },
    });

    logger.info(`Set role ${roleId} as project lead: ${isProjectLead}`);
  }

  async listProjectLeads(companyId: string): Promise<RoleWithCapabilities[]> {
    const roles = await this.prisma.role.findMany({
      where: { companyId, isProjectLead: true, status: 'active' },
    });

    return Promise.all(roles.map(r => this.getById(r.id) as Promise<RoleWithCapabilities>));
  }
}

export const roleService = new RoleService(prisma);
