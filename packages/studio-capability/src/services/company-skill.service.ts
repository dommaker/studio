/**
 * ⚠️ DEPRECATED: 公司技能库服务
 * 
 * 废弃原因：
 * 1. 无真实公司定制需求
 * 2. RoleSkill 授权机制未实现（SL-003）
 * 3. 继承机制未实际使用
 * 
 * 建议：保留代码，待未来业务需求触发
 * 
 * 负责：
 * 1. CRUD 操作
 * 2. 继承 global 技能配置
 * 3. 配置覆盖合并
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

type JsonValue = Prisma.JsonValue;
type InputJsonValue = Prisma.InputJsonValue;

export interface CreateCompanySkillInput {
  companyId: string;
  name: string;
  description?: string;
  category?: string;
  parentSkillId?: string;
  layer?: 'atomic' | 'composite' | 'company';
  config?: Record<string, unknown>;
  requirements?: {
    minLevel?: number;
    allowedRoles?: string[];
  };
}

export interface UpdateCompanySkillInput {
  name?: string;
  description?: string;
  category?: string;
  config?: Record<string, unknown>;
  requirements?: Record<string, unknown>;
  status?: 'active' | 'deprecated' | 'draft';
}

export interface ListCompanySkillsQuery {
  companyId: string;
  category?: string;
  layer?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class CompanySkillService {
  /**
   * 创建公司技能
   */
  async create(input: CreateCompanySkillInput) {
    // 检查技能名唯一性
    const existing = await prisma.companySkill.findFirst({
      where: { companyId: input.companyId, name: input.name },
    });

    if (existing) {
      throw new Error(`技能名 "${input.name}" 已存在于该公司`);
    }

    const skill = await prisma.companySkill.create({
      data: {
        companyId: input.companyId,
        name: input.name,
        description: input.description,
        category: input.category,
        parentSkillId: input.parentSkillId,
        layer: input.layer || 'company',
        config: input.config as unknown as string,
        requirements: input.requirements as unknown as string,
      },
    });

    logger.info(`[CompanySkillService] 创建技能: ${skill.id} - ${skill.name}`);
    return skill;
  }

  /**
   * 查询技能列表
   */
  async list(query: ListCompanySkillsQuery) {
    const where: any = { companyId: query.companyId };

    if (query.category) {
      where.category = query.category;
    }

    if (query.layer) {
      where.layer = query.layer;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.search) {
      where.name = { contains: query.search };
    }

    const skills = await prisma.companySkill.findMany({
      where,
      take: query.limit || 50,
      skip: query.offset || 0,
      orderBy: { createdAt: 'desc' },
    });

    const total = await prisma.companySkill.count({ where });

    return { skills, total };
  }

  /**
   * 查询技能详情
   */
  async get(id: string) {
    const skill = await prisma.companySkill.findUnique({
      where: { id },
      include: { company: true },
    });

    if (!skill) {
      throw new Error(`技能不存在: ${id}`);
    }

    return skill;
  }

  /**
   * 更新技能
   */
  async update(id: string, input: UpdateCompanySkillInput) {
    const skill = await prisma.companySkill.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        category: input.category,
        config: input.config as unknown as string,
        requirements: input.requirements as unknown as string,
        status: input.status,
      },
    });

    logger.info(`[CompanySkillService] 更新技能: ${id}`);
    return skill;
  }

  /**
   * 删除技能
   */
  async delete(id: string) {
    await prisma.companySkill.delete({ where: { id } });
    logger.info(`[CompanySkillService] 删除技能: ${id}`);
  }

  /**
   * 继承 global 技能
   */
  async inheritFromGlobal(
    companyId: string,
    parentSkillId: string,
    overrides?: Record<string, unknown>
  ) {
    // 获取 parent 技能
    const parent = await prisma.companySkill.findUnique({
      where: { id: parentSkillId },
    });

    if (!parent) {
      throw new Error(`父技能不存在: ${parentSkillId}`);
    }

    // 合并配置
    const parentConfig = (typeof parent.config === 'string' ? JSON.parse(parent.config) : parent.config) as Record<string, unknown> || {};
    const mergedConfig = { ...parentConfig, ...overrides };

    // 创建继承技能
    const child = await prisma.companySkill.create({
      data: {
        companyId,
        name: `${parent.name}-custom`,
        description: parent.description,
        category: parent.category,
        parentSkillId,
        layer: 'company',
        config: mergedConfig as unknown as string,
      },
    });

    logger.info(`[CompanySkillService] 继承技能: ${parent.name} -> ${child.id}`);
    return child;
  }

  /**
   * 获取有效配置（合并 parent + company）
   */
  async getEffectiveConfig(skillId: string): Promise<Record<string, unknown>> {
    const skill = await prisma.companySkill.findUnique({
      where: { id: skillId },
    });

    if (!skill) {
      throw new Error(`技能不存在: ${skillId}`);
    }

    const skillConfig = (typeof skill.config === 'string' ? JSON.parse(skill.config) : skill.config) as Record<string, unknown> || {};

    if (!skill.parentSkillId) {
      return skillConfig;
    }

    // 获取 parent 配置
    const parent = await prisma.companySkill.findUnique({
      where: { id: skill.parentSkillId },
    });

    if (!parent) {
      return skillConfig;
    }

    // 合并配置
    const parentConfig = (typeof parent.config === 'string' ? JSON.parse(parent.config) : parent.config) as Record<string, unknown> || {};
    return { ...parentConfig, ...skillConfig };
  }

  /**
   * 更新技能统计（SL-005）
   */
  async updateStats(skillId: string, success: boolean, duration: number) {
    const skill = await prisma.companySkill.findUnique({
      where: { id: skillId },
    });

    if (!skill) return;

    // 计算新统计
    const newUsageCount = skill.usageCount + 1;
    const newSuccessRate = success
      ? (skill.successRate * skill.usageCount + 1) / newUsageCount
      : (skill.successRate * skill.usageCount) / newUsageCount;
    const newAvgDuration =
      (skill.avgDuration * skill.usageCount + duration) / newUsageCount;

    await prisma.companySkill.update({
      where: { id: skillId },
      data: {
        usageCount: newUsageCount,
        successRate: newSuccessRate,
        avgDuration: newAvgDuration,
      },
    });
  }
}

export const companySkillService = new CompanySkillService();