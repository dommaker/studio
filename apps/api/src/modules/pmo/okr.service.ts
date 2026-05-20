// OKR Service - PMO 模块核心服务
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

export interface OKRObjective {
  id: string;
  title: string;
  description?: string;
}

export interface OKRKeyResult {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
}

export interface CreateOKRInput {
  companyId: string;
  title: string;
  objectives: OKRObjective[];
  keyResults: OKRKeyResult[];
  quarter: string;
}

export interface UpdateOKRInput {
  title?: string;
  objectives?: OKRObjective[];
  keyResults?: OKRKeyResult[];
  status?: string;
}

/**
 * 🆕 AS-016: 获取当前季度
 */
export function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/**
 * OKR 服务
 */
export class OKRService {
  /**
   * 创建 OKR
   */
  async create(input: CreateOKRInput) {
    // 检查是否已存在相同 quarter 的 OKR
    const existing = await prisma.oKR.findUnique({
      where: {
        companyId_quarter: {
          companyId: input.companyId,
          quarter: input.quarter,
        },
      },
    });

    if (existing) {
      throw new Error(`OKR for quarter ${input.quarter} already exists`);
    }

    // 计算初始进度
    const progress = this.calculateProgress(input.keyResults);

    const okr = await prisma.oKR.create({
      data: {
        companyId: input.companyId,
        title: input.title,
        objectives: JSON.parse(JSON.stringify(input.objectives)),
        keyResults: JSON.parse(JSON.stringify(input.keyResults)),
        quarter: input.quarter,
        progress,
      },
    });

    logger.info({ okrId: okr.id, companyId: input.companyId }, 'OKR created');
    return okr;
  }

  /**
   * 获取 OKR 列表
   */
  async list(companyId: string, options?: { status?: string }) {
    const where: Record<string, unknown> = { companyId };
    if (options?.status) {
      where.status = options.status;
    }

    const okrs = await prisma.oKR.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { Execution: true },
        },
      },
    });

    return okrs.map(okr => ({
      ...okr,
      projectCount: okr._count.Execution,
    }));
  }

  /**
   * 获取 OKR 详情
   */
  async get(id: string) {
    const okr = await prisma.oKR.findUnique({
      where: { id },
      include: {
        Company: {
          select: { name: true, adminRoleIds: true },
        },
        Execution: {
          select: {
            id: true,
            workflowId: true,
            status: true,
            startTime: true,
            endTime: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!okr) {
      throw new Error('OKR not found');
    }

    return okr;
  }

  /**
   * 更新 OKR
   */
  async update(id: string, input: UpdateOKRInput) {
    const okr = await prisma.oKR.findUnique({
      where: { id },
    });

    if (!okr) {
      throw new Error('OKR not found');
    }

    // 如果更新了 keyResults，重新计算进度
    let progress = okr.progress;
    if (input.keyResults) {
      progress = this.calculateProgress(input.keyResults);
    }

    const updated = await prisma.oKR.update({
      where: { id },
      data: {
        title: input.title,
        objectives: input.objectives ? JSON.parse(JSON.stringify(input.objectives)) : undefined,
        keyResults: input.keyResults ? JSON.parse(JSON.stringify(input.keyResults)) : undefined,
        status: input.status,
        progress,
      },
    });

    logger.info({ okrId: id }, 'OKR updated');
    return updated;
  }

  /**
   * 删除 OKR
   */
  async delete(id: string) {
    // 检查是否有关联的项目
    const executionCount = await prisma.execution.count({
      where: { okrId: id },
    });

    if (executionCount > 0) {
      // 不删除关联项目，只是解除关联
      await prisma.execution.updateMany({
        where: { okrId: id },
        data: { okrId: null },
      });
    }

    await prisma.oKR.delete({
      where: { id },
    });

    logger.info({ okrId: id, executionCount }, 'OKR deleted');
    return { success: true, unlinkedProjects: executionCount };
  }

  /**
   * 计算进度
   */
  private calculateProgress(keyResults: OKRKeyResult[]): number {
    if (keyResults.length === 0) return 0;

    const totalProgress = keyResults.reduce((sum, kr) => {
      const progress = Math.min(kr.current / kr.target, 1);
      return sum + progress;
    }, 0);

    return totalProgress / keyResults.length;
  }

  /**
   * 检查权限（是否是管理员）
   */
  async checkPermission(roleId: string, companyId: string): Promise<boolean> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { adminRoleIds: true },
    });

    if (!company) {
      return false;
    }

    return company.adminRoleIds.includes(roleId);
  }

  /**
   * 初始化管理员（将 CEO 加入 adminRoleIds）
   */
  async initAdmin(companyId: string) {
    // 查找 CEO 角色
    const ceoRole = await prisma.role.findFirst({
      where: {
        companyId,
        type: 'ceo',
      },
    });

    if (!ceoRole) {
      logger.warn({ companyId }, 'CEO role not found, cannot init admin');
      return;
    }

    // 更新公司管理员列表
    await prisma.company.update({
      where: { id: companyId },
      data: {
        adminRoleIds: [ceoRole.id],
      },
    });

    logger.info({ companyId, ceoRoleId: ceoRole.id }, 'Admin initialized');
  }

  /**
   * 🆕 AS-016: 获取公司当前季度默认 OKR
   */
  async getDefaultOKR(companyId: string): Promise<string | null> {
    const currentQuarter = getCurrentQuarter();
    
    const okr = await prisma.oKR.findFirst({
      where: { 
        companyId,
        quarter: currentQuarter,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
    });
    
    return okr?.id || null;
  }

  /**
   * 🆕 AS-016: 创建默认 OKR（公司创建时）
   */
  async createDefaultOKR(companyId: string): Promise<{ id: string; title: string; quarter: string }> {
    const currentQuarter = getCurrentQuarter();
    
    const okr = await this.create({
      companyId,
      title: `${currentQuarter} 默认 OKR`,
      quarter: currentQuarter,
      objectives: [{ id: '1', title: '季度目标' }],
      keyResults: [],
    });
    
    logger.info({ companyId, okrId: okr.id, quarter: currentQuarter }, 'Default OKR created');
    return okr;
  }

  /**
   * 🆕 AS-016: 更新 OKR 进度（基于关联项目）
   */
  async updateProgress(okrId: string): Promise<number> {
    const projects = await prisma.project.findMany({
      where: { okrId },
      select: { progress: true, status: true },
    });
    
    if (projects.length === 0) {
      return 0;
    }
    
    // 只计算 active/in_review/completed 的项目
    const activeProjects = projects.filter(p => 
      ['active', 'in_review', 'completed'].includes(p.status)
    );
    
    if (activeProjects.length === 0) {
      return 0;
    }
    
    const avgProgress = activeProjects.reduce((sum, p) => sum + p.progress, 0) / activeProjects.length;
    
    await prisma.oKR.update({
      where: { id: okrId },
      data: { progress: Math.round(avgProgress) },
    });
    
    logger.info({ okrId, progress: Math.round(avgProgress), projectCount: activeProjects.length }, 'OKR progress updated');
    return Math.round(avgProgress);
  }
}

export const okrService = new OKRService();