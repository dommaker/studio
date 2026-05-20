/**
 * Capability Service - 能力管理服务
 * 
 * 负责能力的 CRUD、同步、统计
 * AS-014: 新增市场功能（发布、购买、评价）
 */

import { PrismaClient, Prisma, Capability as PrismaCapability, CapabilityReview } from '@prisma/client';
import { logger } from '@dommaker/studio-shared';
import { getRegistryPath } from '@dommaker/harness';
import * as fs from 'fs';

// 能力类型定义（来自 registry）
interface RegistryCapability {
  name: string;
  type: 'tool' | 'workflow' | 'skill';
  category: string;
  description: string;
  path: string;
}

interface Registry {
  tools: RegistryCapability[];
}

// 能力消耗配置（按类型）
const CAPABILITY_COST: Record<string, number> = {
  tool: 1000,
  step: 3000,
  workflow: 10000,
  skill: 5000,
};

export class CapabilityService {
  private registryPath: string;

  constructor(private prisma: PrismaClient, registryPath?: string) {
    this.registryPath = registryPath || getRegistryPath();
  }

  /**
   * 创建能力
   */
  async create(input: {
    name: string;
    type: string;
    description?: string;
    cost?: number;
    metadata?: any;
  }): Promise<PrismaCapability> {
    const cost = input.cost || CAPABILITY_COST[input.type] || 1000;

    return this.prisma.capability.create({
      data: {
        name: input.name,
        type: input.type,
        description: input.description,
        cost,
        metadata: input.metadata || null,
      },
    });
  }

  /**
   * 批量创建能力
   */
  async createMany(capabilities: Array<{
    name: string;
    type: string;
    description?: string;
    cost?: number;
    metadata?: any;
  }>): Promise<number> {
    const result = await this.prisma.capability.createMany({
      data: capabilities.map((c) => ({
        name: c.name,
        type: c.type,
        description: c.description,
        cost: c.cost || CAPABILITY_COST[c.type] || 1000,
        metadata: c.metadata || null,
      })),
    });

    logger.info(`Created ${result.count} capabilities`);
    return result.count;
  }

  /**
   * 获取能力详情
   */
  async getById(capabilityId: string): Promise<PrismaCapability | null> {
    return this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });
  }

  /**
   * 按名称获取能力
   */
  async getByName(name: string, type?: string): Promise<PrismaCapability | null> {
    return this.prisma.capability.findFirst({
      where: {
        name,
        ...(type && { type }),
      },
    });
  }

  /**
   * 获取能力列表
   */
  async list(options?: {
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: PrismaCapability[]; total: number }> {
    const { type, status, page = 1, limit = 50 } = options || {};

    const where: Prisma.CapabilityWhereInput = {};
    if (type) where.type = type;
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.capability.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.capability.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * 更新能力
   */
  async update(capabilityId: string, input: {
    description?: string;
    cost?: number;
    status?: string;
    metadata?: any;
  }): Promise<PrismaCapability> {
    return this.prisma.capability.update({
      where: { id: capabilityId },
      data: {
        ...input,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * 删除能力
   */
  async delete(capabilityId: string): Promise<void> {
    await this.prisma.capability.delete({
      where: { id: capabilityId },
    });
  }

  /**
   * 从 Registry 同步能力到数据库
   */
  async syncFromRegistry(): Promise<{
    added: number;
    updated: number;
    total: number;
  }> {
    // 读取 Registry
    const registry = this.loadRegistry();
    
    const allCapabilities: RegistryCapability[] = [
      ...registry.tools.map((c) => ({ ...c, type: 'tool' as const })),
    ];

    let added = 0;
    let updated = 0;

    for (const cap of allCapabilities) {
      const existing = await this.getByName(cap.name, cap.type);

      if (existing) {
        // 更新描述
        if (cap.description !== existing.description) {
          await this.prisma.capability.update({
            where: { id: existing.id },
            data: { description: cap.description },
          });
          updated++;
        }
      } else {
        // 创建新能力
        await this.create({
          name: cap.name,
          type: cap.type,
          description: cap.description,
          metadata: {
            category: cap.category,
            path: cap.path,
          },
        });
        added++;
      }
    }

    logger.info(`Synced capabilities from registry: added ${added}, updated ${updated}`);

    return {
      added,
      updated,
      total: allCapabilities.length,
    };
  }

  /**
   * 加载 Registry 文件
   */
  private loadRegistry(): Registry {
    try {
      const content = fs.readFileSync(this.registryPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to load registry', { error: error instanceof Error ? error.message : String(error) });
      return { tools: [] };
    }
  }

  /**
   * 获取能力统计
   */
  async getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const capabilities = await this.prisma.capability.findMany();

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const cap of capabilities) {
      byType[cap.type] = (byType[cap.type] || 0) + 1;
      byStatus[cap.status] = (byStatus[cap.status] || 0) + 1;
    }

    return {
      total: capabilities.length,
      byType,
      byStatus,
    };
  }

  /**
   * 获取能力消耗配置
   */
  getCostConfig(): Record<string, number> {
    return CAPABILITY_COST;
  }

  // ==================== AS-014 市场功能 ====================

  /**
   * 发布能力到市场
   */
  async publishToMarket(input: {
    capabilityId: string;
    ownerId: string;    // 角色ID
    companyId?: string; // 公司ID（分成）
    price: number;
  }): Promise<PrismaCapability> {
    const capability = await this.getById(input.capabilityId);
    if (!capability) {
      throw new Error('Capability not found');
    }

    if (capability.ownershipType === 'market') {
      throw new Error('Capability already published to market');
    }

    return this.prisma.capability.update({
      where: { id: input.capabilityId },
      data: {
        ownershipType: 'market',
        ownerId: input.ownerId,
        price: input.price,
        reviewStatus: 'pending',
        autoTestStatus: 'pending',
        userApprovalStatus: 'pending',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * 获取市场能力列表
   */
  async listMarket(options?: {
    type?: string;
    minRating?: number;
    sortBy?: 'rating' | 'usageCount' | 'price';
    page?: number;
    limit?: number;
  }): Promise<{ data: PrismaCapability[]; total: number }> {
    const { type, minRating, sortBy = 'rating', page = 1, limit = 50 } = options || {};

    const where: Prisma.CapabilityWhereInput = {
      ownershipType: 'market',
      reviewStatus: 'approved', // 只显示已审核通过的
    };

    if (type) where.type = type;
    if (minRating) where.rating = { gte: minRating };

    const orderBy: Prisma.CapabilityOrderByWithRelationInput = {};
    if (sortBy === 'rating') orderBy.rating = 'desc';
    else if (sortBy === 'usageCount') orderBy.usageCount = 'desc';
    else if (sortBy === 'price') orderBy.price = 'asc';

    const [data, total] = await Promise.all([
      this.prisma.capability.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
      }),
      this.prisma.capability.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * 购买市场能力
   */
  async purchase(input: {
    capabilityId: string;
    buyerRoleId: string;
    buyerCompanyId?: string;
  }): Promise<{
    success: boolean;
    capability: PrismaCapability;
    roleCapabilityId: string;
  }> {
    const capability = await this.getById(input.capabilityId);
    if (!capability) {
      throw new Error('Capability not found');
    }

    if (capability.ownershipType !== 'market') {
      throw new Error('Capability not in market');
    }

    if (capability.reviewStatus !== 'approved') {
      throw new Error('Capability not approved');
    }

    // 检查是否已购买
    // Note: roleCapability model not in generated Prisma client (pre-existing schema gap)
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const existing = await prismaAny.roleCapability.findFirst({
      where: {
        roleId: input.buyerRoleId,
        capabilityId: input.capabilityId,
      },
    });

    if (existing) {
      return {
        success: false,
        capability,
        roleCapabilityId: existing.id,
      };
    }

    // 创建角色-能力关联
    const roleCapability = await prismaAny.roleCapability.create({
      data: {
        roleId: input.buyerRoleId,
        capabilityId: input.capabilityId,
        source: 'purchased',
        isPrivate: false,
      },
    });

    // 更新使用次数
    await this.prisma.capability.update({
      where: { id: input.capabilityId },
      data: {
        usageCount: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    logger.info(`Role ${input.buyerRoleId} purchased capability ${input.capabilityId}`);

    return {
      success: true,
      capability,
      roleCapabilityId: roleCapability.id,
    };
  }

  /**
   * 评价能力
   */
  async rate(input: {
    capabilityId: string;
    roleId: string;
    score: number;  // 1-5
    comment?: string;
  }): Promise<CapabilityReview> {
    if (input.score < 1 || input.score > 5) {
      throw new Error('Score must be between 1 and 5');
    }

    // 检查是否已评价
    const existing = await this.prisma.capabilityReview.findUnique({
      where: {
        capabilityId_roleId: {
          capabilityId: input.capabilityId,
          roleId: input.roleId,
        },
      },
    });

    if (existing) {
      // 更新评价
      return this.prisma.capabilityReview.update({
        where: { id: existing.id },
        data: {
          score: input.score,
          comment: input.comment,
        },
      });
    }

    // 创建新评价
    const review = await this.prisma.capabilityReview.create({
      data: {
        capabilityId: input.capabilityId,
        roleId: input.roleId,
        score: input.score,
        comment: input.comment,
      },
    });

    // 更新能力评分
    await this.updateRating(input.capabilityId);

    logger.info(`Role ${input.roleId} rated capability ${input.capabilityId}: ${input.score}`);

    return review;
  }

  /**
   * 更新能力评分（计算平均分）
   */
  private async updateRating(capabilityId: string): Promise<void> {
    const reviews = await this.prisma.capabilityReview.findMany({
      where: { capabilityId },
    });

    if (reviews.length === 0) return;

    const avgRating = reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length;

    await this.prisma.capability.update({
      where: { id: capabilityId },
      data: {
        rating: Math.round(avgRating * 100) / 100, // 保留两位小数
        reviewCount: reviews.length,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * 获取能力评价列表
   */
  async getReviews(capabilityId: string, options?: {
    page?: number;
    limit?: number;
  }): Promise<{ data: CapabilityReview[]; total: number }> {
    const { page = 1, limit = 20 } = options || {};

    const [data, total] = await Promise.all([
      this.prisma.capabilityReview.findMany({
        where: { capabilityId },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.capabilityReview.count({ where: { capabilityId } }),
    ]);

    return { data, total };
  }

  /**
   * 获取市场统计
   */
  async getMarketStats(): Promise<{
    totalCapabilities: number;
    totalReviews: number;
    avgRating: number;
    totalUsage: number;
    byType: Record<string, number>;
  }> {
    const marketCapabilities = await this.prisma.capability.findMany({
      where: {
        ownershipType: 'market',
        reviewStatus: 'approved',
      },
    });

    const reviews = await this.prisma.capabilityReview.findMany();
    const byType: Record<string, number> = {};

    for (const cap of marketCapabilities) {
      byType[cap.type] = (byType[cap.type] || 0) + 1;
    }

    const totalUsage = marketCapabilities.reduce((sum, c) => sum + c.usageCount, 0);
    const avgRating = marketCapabilities.length > 0
      ? marketCapabilities.reduce((sum, c) => sum + c.rating, 0) / marketCapabilities.length
      : 0;

    return {
      totalCapabilities: marketCapabilities.length,
      totalReviews: reviews.length,
      avgRating: Math.round(avgRating * 100) / 100,
      totalUsage,
      byType,
    };
  }
}