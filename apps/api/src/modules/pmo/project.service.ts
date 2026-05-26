/**
 * Project Service - PMO 项目管理
 * 
 * GEN-005: PMO 号生成 + 项目 CRUD
 */

import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

export interface CreateProjectInput {
  companyId: string;
  title: string;
  description?: string;
  requirement?: string;
  okrId?: string;
  priority?: string;
  gitBranch?: string;
  gitRepo?: string;
  requirementsDocId?: string;  // A4: bidirectional link to RequirementsDoc
}

export interface UpdateProjectInput {
  title?: string;
  description?: string;
  requirement?: string;
  okrId?: string;
  status?: string;
  priority?: string;
  progress?: number;
  gitBranch?: string;
  gitRepo?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProjectListOptions {
  status?: string;
  priority?: string;
  okrId?: string;
  limit?: number;
  offset?: number;
}

// ============================================
// FL-018: Project 状态机
// ============================================

/**
 * Project 状态常量
 */
export const PROJECT_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  IN_REVIEW: 'in_review',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type ProjectStatus = typeof PROJECT_STATUS[keyof typeof PROJECT_STATUS];

/**
 * 状态转换规则
 * 
 * pending → active（任务开始执行）
 * active → in_review（所有任务完成）
 * in_review → completed（PR merged）
 * * → cancelled（手动取消）
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  [PROJECT_STATUS.PENDING]: [PROJECT_STATUS.ACTIVE, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.ACTIVE]: [PROJECT_STATUS.IN_REVIEW, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.IN_REVIEW]: [PROJECT_STATUS.COMPLETED, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.COMPLETED]: [], // 终态，不可转换
  [PROJECT_STATUS.CANCELLED]: [PROJECT_STATUS.PENDING], // 可恢复
};

/**
 * 验证状态转换是否合法
 */
export function validateTransition(currentStatus: string, newStatus: string): boolean {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  return allowed.includes(newStatus);
}

// ============================================
// PMO 号生成
// ============================================

/**
 * 生成 PMO 号（3 位数字）
 * 
 * 格式：PM-001
 * 生成规则：公司内唯一，自动递增
 */
export async function generatePmoNumber(companyId: string): Promise<string> {
  const latestProject = await prisma.project.findFirst({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
  });

  let nextNumber = 1;
  if (latestProject) {
    const match = latestProject.pmoNumber.match(/PM-(\d+)/);
    if (match) {
      nextNumber = parseInt(match[1]) + 1;
    }
  }

  const pmoNumber = `PM-${nextNumber.toString().padStart(3, '0')}`;
  logger.info({ companyId, pmoNumber }, 'Generated PMO number');

  return pmoNumber;
}

/**
 * 解析 CEO 指令中的 PMO 号
 * 
 * 支持格式：
 * - @PM-001 → 关联已有项目
 * - #新项目 → 明确创建新项目
 * - 无标记 → 默认创建新项目
 */
export function parsePmoNumberFromCommand(command: string): {
  type: 'link' | 'create' | 'auto';
  pmoNumber?: string;
} {
  // 检测 @PM-xxx → 关联已有项目
  const linkMatch = command.match(/@PM-(\d{3})/);
  if (linkMatch) {
    return { type: 'link', pmoNumber: `PM-${linkMatch[1]}` };
  }

  // 检测 #新项目 → 明确创建新项目
  if (command.includes('#新项目')) {
    return { type: 'create' };
  }

  // 无标记 → 自动创建新项目
  return { type: 'auto' };
}

// ============================================
// Project CRUD
// ============================================

export const projectService = {
  /**
   * 创建项目（自动生成 PMO 号）
   */
  async create(input: CreateProjectInput) {
    const pmoNumber = await generatePmoNumber(input.companyId);

    const project = await prisma.project.create({
      data: {
        pmoNumber,
        title: input.title,
        description: input.description,
        requirement: input.requirement,
        companyId: input.companyId,
        okrId: input.okrId,
        priority: input.priority || 'normal',
        gitBranch: input.gitBranch,
        gitRepo: input.gitRepo,
        requirementsDocId: input.requirementsDocId,
        status: 'pending',
        progress: 0,
      },
      include: {
        Company: true,
        okr: true,  // 🔧 修复：Prisma 字段名是 okr（小写）
      },
    });

    logger.info({ projectId: project.id, pmoNumber }, 'Project created');
    return project;
  },

  /**
   * 获取项目详情
   * 
   * 🆕 FL-021: 包含 Meeting 关联（历史追溯）
   */
  async get(projectId: string) {
    return prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        pmoNumber: true,
        title: true,
        description: true,
        requirement: true,
        status: true,
        priority: true,
        progress: true,
        gitBranch: true,
        gitRepo: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        Company: { select: { id: true, name: true, size: true, balance: true } },
        okr: { select: { id: true, title: true, quarter: true } },
      },
    });
  },

  /**
   * 通过 PMO 号获取项目
   */
  async getByPmoNumber(companyId: string, pmoNumber: string) {
    return prisma.project.findUnique({
      where: {
        companyId_pmoNumber: { companyId, pmoNumber },
      },
      include: {
        Company: true,
        okr: true,
      },
    });
  },

  /**
   * 获取项目列表
   */
  async list(companyId: string, options: ProjectListOptions = {}) {
    return prisma.project.findMany({
      where: {
        companyId,
        ...(options.status && { status: options.status }),
        ...(options.priority && { priority: options.priority }),
        ...(options.okrId && { okrId: options.okrId }),
      },
      orderBy: { createdAt: 'desc' },
      take: options.limit || 20,
      skip: options.offset || 0,
      include: {
        okr: true,
      },
    });
  },

  /**
   * 更新项目
   */
  async update(projectId: string, input: UpdateProjectInput) {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: input,
      include: {
        Company: true,
        okr: true,
      },
    });

    logger.info({ projectId, updates: input }, 'Project updated');
    return project;
  },

  /**
   * 更新项目状态（FL-018: 状态机验证）
   */
  async updateStatus(projectId: string, status: string, skipValidation = false) {
    const now = new Date();
    const current = await prisma.project.findUnique({ where: { id: projectId } });

    if (!current) {
      throw new Error('Project not found');
    }

    // 验证状态转换是否合法
    if (!skipValidation && !validateTransition(current.status, status)) {
      logger.warn({ projectId, currentStatus: current.status, newStatus: status }, 'Invalid status transition');
      throw new Error(`Invalid status transition: ${current.status} → ${status}`);
    }

    const updateData: Record<string, unknown> = { status };

    // 自动更新时间戳
    if (status === PROJECT_STATUS.ACTIVE && !current.startedAt) {
      updateData.startedAt = now;
    }
    if (status === PROJECT_STATUS.COMPLETED) {
      updateData.completedAt = now;
      updateData.progress = 100;
    }

    logger.info({ projectId, from: current.status, to: status }, 'Project status transition');
    return this.update(projectId, updateData);
  },

  /**
   * 尝试激活项目（pending → active）
   * 用于任务领取/会议结束时触发
   */
  async tryActivate(projectId: string): Promise<boolean> {
    const current = await prisma.project.findUnique({ where: { id: projectId } });
    
    if (!current || current.status !== PROJECT_STATUS.PENDING) {
      return false; // 不是 pending 状态，不触发
    }

    await this.updateStatus(projectId, PROJECT_STATUS.ACTIVE, true);
    logger.info({ projectId, pmoNumber: current.pmoNumber }, 'Project activated (pending → active)');
    return true;
  },

  /**
   * 删除项目（仅 pending/cancelled 状态）
   */
  async delete(projectId: string) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    if (project.status !== 'pending' && project.status !== 'cancelled') {
      throw new Error('Can only delete pending or cancelled projects');
    }

    await prisma.project.delete({
      where: { id: projectId },
    });

    logger.info({ projectId }, 'Project deleted');
    return { success: true };
  },

  /**
   * 计算项目进度（基于 Task 完成比例）
   */
  async calculateProgress(projectId: string): Promise<number> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return 0;
    }

    const [total, completed] = await Promise.all([
      prisma.task.count({ where: { projectId } }),
      prisma.task.count({ where: { projectId, status: 'completed' } }),
    ]);

    if (total === 0) {
      return project.progress;
    }

    return Math.round((completed / total) * 100);
  }
};