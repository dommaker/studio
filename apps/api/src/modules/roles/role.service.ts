/**
 * Role Service - 角色管理服务
 * 
 * 负责角色的 CRUD 操作、级别计算、能力管理
 * 
 * 2026-04-22: 概念简化（移除 Skills 层）
 * - Role 直接拥有 workflows（复合能力）
 * - Skills 层已移除，不再需要 Role.skills 和 skillConfig
 * 
 * 2026-04-22: 责任链模型（RC-007）
 * - 使用 deriveRoleConfig() 推导 workflows
 * - 移除硬编码的 ROLE_TYPE_CONFIG
 */

import { Prisma, Role } from '@prisma/client';
import { PrismaClient, prisma } from '@dommaker/studio-prisma';
import { logger, LEVEL_CONFIG, getLevelConfig as getSharedLevelConfig } from '@dommaker/studio-shared';

// ========== 责任链模型（本地实现）==========

/**
 * Stage 定义（责任链模型）
 */
type Stage = 'plan' | 'develop' | 'verify' | 'deploy' | 'fix' | 'govern';
type RoleType = 'architect' | 'tech-lead' | 'developer' | 'qa' | 'pm' | 'ceo' | 'reviewer' | 'strategy-lead';

/**
 * 责任链配置（单一数据源）
 */
const RESPONSIBILITY_CHAIN: Record<Stage, RoleType[]> = {
  plan: ['architect', 'pm', 'tech-lead'],
  develop: ['tech-lead', 'developer'],
  verify: ['qa', 'tech-lead', 'reviewer'],
  deploy: ['tech-lead', 'pm'],
  fix: ['tech-lead', 'developer'],
  govern: ['architect', 'tech-lead', 'pm', 'ceo'],
};

/**
 * Stage → Workflow 映射
 */
const STAGE_WORKFLOWS: Record<Stage, string[]> = {
  plan: ['wf-planning', 'wf-architecture-review'],
  develop: ['wf-dev', 'wf-iterate'],
  verify: ['wf-test', 'wf-review'],
  deploy: ['wf-release'],
  fix: ['wf-bugfix', 'wf-patch'],
  govern: ['wf-evolution', 'wf-audit'],
};

/**
 * 角色名称
 */
const ROLE_NAMES: Record<RoleType, string> = {
  'architect': '架构师',
  'tech-lead': '技术负责人',
  'developer': '开发工程师',
  'qa': '测试工程师',
  'pm': '产品经理',
  'ceo': '决策者',
  'reviewer': '评审专家',
  'strategy-lead': '方案策划',
};

/**
 * 角色描述
 */
const ROLE_DESCRIPTIONS: Record<RoleType, string> = {
  'architect': '技术架构设计、技术选型决策',
  'tech-lead': '技术方案把关、代码审查、任务分配',
  'developer': '代码实现、功能开发、Bug修复',
  'qa': '质量保障、测试验证、验收把关',
  'pm': '需求管理、优先级决策、产品规划',
  'ceo': '高风险决策、战略审批',
  'reviewer': '代码审查、质量把控',
  'strategy-lead': '出方案、发散思考',
};

/**
 * 推导角色配置
 * 
 * 从责任链自动推导：
 * - 可参与的阶段
 * - 可执行的 Workflow
 */
function deriveRoleConfig(role: RoleType): {
  stages: Stage[];
  workflows: string[];
  name: string;
  description: string;
} {
  // 1. 找出有责任的阶段
  const stages: Stage[] = [];
  for (const [stage, chain] of Object.entries(RESPONSIBILITY_CHAIN)) {
    if (chain.includes(role)) {
      stages.push(stage as Stage);
    }
  }

  // 2. 推导可用的 Workflow
  const workflows = stages.flatMap(s => STAGE_WORKFLOWS[s]);
  const uniqueWorkflows = [...new Set(workflows)];

  return {
    stages,
    workflows: uniqueWorkflows,
    name: ROLE_NAMES[role] || role,
    description: ROLE_DESCRIPTIONS[role] || '',
  };
}

export interface CreateRoleInput {
  name: string;
  type: string;
  avatar?: string;
  personality?: {
    prompt: string;
    traits: string[];
  };
  companyId: string;
  // 概念简化：只设置 workflows
  workflows?: string[];
}

export interface UpdateRoleInput {
  name?: string;
  avatar?: string;
  personality?: {
    prompt: string;
    traits: string[];
  };
  status?: string;
  workflows?: string[];
}

export interface RoleWithCapabilities extends Omit<Role, 'workflows'> {
  workflows: string[];
}

// 级别配置 - 使用共享常量（LEVEL_CONFIG 已从 @dommaker/studio-shared 导入）

export class RoleService {
  constructor(private prisma: PrismaClient) {}

  /**
   * 创建角色
   */
  async create(input: CreateRoleInput): Promise<RoleWithCapabilities> {
    const level = 1;
    const config = LEVEL_CONFIG[level];
    
    // 使用 deriveRoleConfig 推导 workflows（责任链模型）
    const roleConfig = deriveRoleConfig(input.type as RoleType);
    const workflows = input.workflows ?? roleConfig.workflows;

    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        type: input.type,
        avatar: input.avatar,
        personality: input.personality || null,
        level,
        capabilityLimit: config.capabilityLimit,
        salary: config.salary,
        companyId: input.companyId,
        workflows: workflows as unknown as Prisma.InputJsonValue,
      },
    });

    return this.getById(role.id) as Promise<RoleWithCapabilities>;
  }

  /**
   * 获取角色详情
   */
  async getById(roleId: string): Promise<RoleWithCapabilities | null> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) return null;

    return {
      ...role,
      workflows: (role.workflows as string[]) ?? [],
    };
  }

  /**
   * 获取角色列表
   */
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

  /**
   * 更新角色
   */
  async update(roleId: string, input: UpdateRoleInput): Promise<Role> {
    const updateData: Prisma.RoleUpdateInput = {
      name: input.name,
      avatar: input.avatar,
      personality: input.personality || undefined,
      status: input.status,
      updatedAt: new Date(),
    };

    if (input.workflows !== undefined) {
      updateData.workflows = input.workflows as unknown as Prisma.InputJsonValue;
    }

    return this.prisma.role.update({
      where: { id: roleId },
      data: updateData,
    });
  }

  /**
   * 删除角色
   */
  async delete(roleId: string): Promise<void> {
    await this.prisma.role.delete({
      where: { id: roleId },
    });
  }

  /**
   * 检查并更新级别
   */
  async checkLevelUp(roleId: string): Promise<{ canPromote: boolean; nextLevel?: number }> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) {
      throw new Error('Role not found');
    }

    const currentLevel = role.level;
    const nextLevel = currentLevel + 1;

    if (nextLevel > 4) {
      return { canPromote: false };
    }

    const nextConfig = LEVEL_CONFIG[nextLevel];

    const canPromote =
      role.tasksCompleted >= nextConfig.minTasks &&
      role.qualityScore >= nextConfig.minQuality;

    return { canPromote, nextLevel: canPromote ? nextLevel : undefined };
  }

  /**
   * 晋升角色
   */
  async promote(roleId: string): Promise<Role> {
    const { canPromote, nextLevel } = await this.checkLevelUp(roleId);

    if (!canPromote || !nextLevel) {
      throw new Error('Role does not meet promotion requirements');
    }

    const config = LEVEL_CONFIG[nextLevel];

    return this.prisma.role.update({
      where: { id: roleId },
      data: {
        level: nextLevel,
        capabilityLimit: config.capabilityLimit,
        salary: config.salary,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * 更新绩效统计
   */
  async updatePerformance(
    roleId: string,
    data: { qualityScore?: number; satisfaction?: boolean }
  ): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) return;

    const updates: Prisma.RoleUpdateInput = {
      tasksCompleted: { increment: 1 },
    };

    if (data.qualityScore !== undefined) {
      const newCount = role.tasksCompleted + 1;
      const newQuality =
        (role.qualityScore * role.tasksCompleted + data.qualityScore) / newCount;
      updates.qualityScore = newQuality;
    }

    if (data.satisfaction !== undefined) {
      const newCount = role.tasksCompleted + 1;
      const newSatisfaction =
        (role.satisfactionRate * role.tasksCompleted + (data.satisfaction ? 1 : 0)) / newCount;
      updates.satisfactionRate = newSatisfaction;
    }

    await this.prisma.role.update({
      where: { id: roleId },
      data: updates,
    });
  }

  /**
   * 获取角色类型列表
   */
  getRoleTypes(): Array<{ 
    type: string; 
    name: string; 
    description: string;
    defaultWorkflows: string[];
  }> {
    // 从责任链推导角色类型配置
    const roleTypes: RoleType[] = ['architect', 'tech-lead', 'developer', 'qa', 'pm', 'ceo', 'reviewer', 'strategy-lead'];
    
    return roleTypes.map(type => {
      const config = deriveRoleConfig(type);
      return {
        type,
        name: config.name,
        description: config.description,
        defaultWorkflows: config.workflows,
      };
    });
  }

  /**
   * 获取级别配置
   */
  getLevelConfig() {
    return LEVEL_CONFIG;
  }

  // ============================================
  // Workflows 管理
  // ============================================

  /**
   * 添加工作流
   */
  async addWorkflows(roleId: string, workflowIds: string[]): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) {
      throw new Error('Role not found');
    }

    const currentWorkflows = role.workflows || [];
    const newWorkflows = [...new Set([...currentWorkflows, ...workflowIds])];

    await this.prisma.role.update({
      where: { id: roleId },
      data: { workflows: newWorkflows },
    });

    logger.info(`Added ${workflowIds.length} workflows to role ${roleId}`);
  }

  /**
   * 移除工作流
   */
  async removeWorkflow(roleId: string, workflowId: string): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) {
      throw new Error('Role not found');
    }

    const newWorkflows = (role.workflows || []).filter(w => w !== workflowId);

    await this.prisma.role.update({
      where: { id: roleId },
      data: { workflows: newWorkflows },
    });
  }

  /**
   * 检查角色是否拥有工作流
   */
  async hasWorkflow(roleId: string, workflowId: string): Promise<boolean> {
    const role = await this.getById(roleId);
    if (!role) return false;
    return role.workflows.includes(workflowId);
  }

  // ============================================
  // AS-048: 项目负责人管理
  // ============================================

  /**
   * 获取项目负责人
   */
  async getProjectLead(companyId: string): Promise<RoleWithCapabilities | null> {
    // Single query: fetch candidates matching any of the 3 fallback criteria
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

    // Priority: projectLead > techLead > any active (first returned)
    const projectLead = candidates.find(r => r.isProjectLead);
    if (projectLead) return this.getById(projectLead.id);

    const techLead = candidates.find(r => r.type === 'tech-lead');
    if (techLead) return this.getById(techLead.id);

    // Fallback: any active role (candidates may be empty if only non-matching exist)
    const anyActive = await this.prisma.role.findFirst({
      where: { companyId, status: 'active' },
    });
    return anyActive ? this.getById(anyActive.id) : null;
  }

  /**
   * 设置项目负责人
   */
  async setProjectLead(roleId: string, isProjectLead: boolean): Promise<void> {
    const role = await this.getById(roleId);
    if (!role) {
      throw new Error('Role not found');
    }

    if (isProjectLead) {
      await this.prisma.role.updateMany({
        where: {
          companyId: role.companyId,
          isProjectLead: true,
        },
        data: {
          isProjectLead: false,
        },
      });
    }

    await this.prisma.role.update({
      where: { id: roleId },
      data: { isProjectLead },
    });

    logger.info(`Set role ${roleId} as project lead: ${isProjectLead}`);
  }

  /**
   * 获取所有项目负责人
   */
  async listProjectLeads(companyId: string): Promise<RoleWithCapabilities[]> {
    const roles = await this.prisma.role.findMany({
      where: {
        companyId,
        isProjectLead: true,
        status: 'active',
      },
    });

    return Promise.all(roles.map(r => this.getById(r.id) as Promise<RoleWithCapabilities>));
  }

  // ============================================
  // AR-009: 入职时间查询（豁免规则）
  // ============================================

  /**
   * 获取角色入职时间
   */
  async getJoinDate(roleId: string): Promise<Date> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { createdAt: true, joinedAt: true },
    });
    
    if (!role) {
      throw new Error(`Role not found: ${roleId}`);
    }
    
    return role.joinedAt || role.createdAt;
  }

  /**
   * 设置角色入职时间
   */
  async setJoinDate(roleId: string, joinedAt: Date): Promise<void> {
    await this.prisma.role.update({
      where: { id: roleId },
      data: { joinedAt },
    });
    
    logger.info(`Set join date for role ${roleId}: ${joinedAt.toISOString()}`);
  }

  /**
   * 检查是否在保护期内（入职 < 3 个月）
   */
  async isInProtectionPeriod(roleId: string, protectionMonths: number = 3): Promise<boolean> {
    const joinDate = await this.getJoinDate(roleId);
    const now = new Date();
    const monthsSinceJoin = (now.getFullYear() - joinDate.getFullYear()) * 12
                          + (now.getMonth() - joinDate.getMonth());

    return monthsSinceJoin < protectionMonths;
  }
}

// 单例实例
export const roleService = new RoleService(prisma);