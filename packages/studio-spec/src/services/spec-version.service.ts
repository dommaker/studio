/**
 * Spec 版本管理服务
 * 
 * 负责：
 * 1. 创建版本快照
 * 2. 查询版本历史
 * 3. 版本对比
 * 4. 版本回滚
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

export interface CreateVersionInput {
  reviewId: string;
  content: any;
  changeType: string;
  changeDesc?: string;
  createdBy: string;
  createdName?: string;
}

export interface VersionDiff {
  added: any[];
  removed: any[];
  modified: any[];
}

export class SpecVersionService {
  /**
   * 创建版本快照
   */
  async createVersion(input: CreateVersionInput) {
    // 获取当前最大版本号
    const latestVersion = await prisma.specVersion.findFirst({
      where: { reviewId: input.reviewId },
      orderBy: { version: 'desc' },
    });

    const newVersion = (latestVersion?.version || 0) + 1;

    // 计算差异（如果有上一版本）
    let diff: any = null;
    if (latestVersion) {
      diff = this.calculateDiff(latestVersion.content as any, input.content);
    }

    const version = await prisma.specVersion.create({
      data: {
        id: this.generateId(),
        reviewId: input.reviewId,
        version: newVersion,
        content: input.content,
        diff,
        changeType: input.changeType,
        changeDesc: input.changeDesc,
        createdBy: input.createdBy,
        createdName: input.createdName,
      },
    });

    logger.info({
      reviewId: input.reviewId,
      version: newVersion,
      changeType: input.changeType,
    }, 'Spec version created');

    return version;
  }

  /**
   * 获取版本历史
   */
  async getVersionHistory(reviewId: string, options?: {
    limit?: number;
    offset?: number;
  }) {
    const [versions, total] = await Promise.all([
      prisma.specVersion.findMany({
        where: { reviewId },
        orderBy: { version: 'desc' },
        take: options?.limit || 50,
        skip: options?.offset || 0,
      }),
      prisma.specVersion.count({ where: { reviewId } }),
    ]);

    return { versions, total };
  }

  /**
   * 获取特定版本
   */
  async getVersion(reviewId: string, version: number) {
    return prisma.specVersion.findUnique({
      where: {
        reviewId_version: {
          reviewId,
          version,
        },
      },
    });
  }

  /**
   * 获取最新版本
   */
  async getLatestVersion(reviewId: string) {
    return prisma.specVersion.findFirst({
      where: { reviewId },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * 版本对比
   */
  async compareVersions(reviewId: string, version1: number, version2: number) {
    const [v1, v2] = await Promise.all([
      this.getVersion(reviewId, version1),
      this.getVersion(reviewId, version2),
    ]);

    if (!v1 || !v2) {
      throw new Error('版本不存在');
    }

    const diff = this.calculateDiff(v1.content as any, v2.content as any);

    return {
      version1: {
        version: v1.version,
        createdAt: v1.createdAt,
        createdBy: v1.createdName || v1.createdBy,
      },
      version2: {
        version: v2.version,
        createdAt: v2.createdAt,
        createdBy: v2.createdName || v2.createdBy,
      },
      diff,
    };
  }

  /**
   * 版本回滚
   * 
   * 注意：回滚会创建一个新版本，内容为目标版本的内容
   */
  async rollbackToVersion(reviewId: string, targetVersion: number, input: {
    createdBy: string;
    createdName?: string;
    reason?: string;
  }) {
    const target = await this.getVersion(reviewId, targetVersion);

    if (!target) {
      throw new Error('目标版本不存在');
    }

    // 创建新版本（内容为目标版本的内容）
    const newVersion = await this.createVersion({
      reviewId,
      content: target.content,
      changeType: 'rollback',
      changeDesc: `回滚到版本 ${targetVersion}${input.reason ? `: ${input.reason}` : ''}`,
      createdBy: input.createdBy,
      createdName: input.createdName,
    });

    logger.info({
      reviewId,
      targetVersion,
      newVersion: newVersion.version,
    }, 'Spec version rollback');

    return newVersion;
  }

  /**
   * 获取版本变更统计
   */
  async getVersionStats(reviewId: string) {
    const versions = await prisma.specVersion.findMany({
      where: { reviewId },
      select: {
        version: true,
        changeType: true,
        createdAt: true,
        createdBy: true,
        createdName: true,
      },
      orderBy: { version: 'asc' },
    });

    const byType: Record<string, number> = {};
    for (const v of versions) {
      byType[v.changeType] = (byType[v.changeType] || 0) + 1;
    }

    return {
      total: versions.length,
      byType,
      versions: versions.map(v => ({
        version: v.version,
        changeType: v.changeType,
        createdAt: v.createdAt,
        createdBy: v.createdName || v.createdBy,
      })),
    };
  }

  /**
   * 计算差异
   */
  private calculateDiff(oldContent: any, newContent: any): VersionDiff {
    const diff: VersionDiff = {
      added: [],
      removed: [],
      modified: [],
    };

    // 简化实现：比较顶层字段
    const oldKeys = new Set(Object.keys(oldContent || {}));
    const newKeys = new Set(Object.keys(newContent || {}));

    // 新增的字段
    for (const key of newKeys) {
      if (!oldKeys.has(key)) {
        diff.added.push({ key, value: newContent[key] });
      }
    }

    // 删除的字段
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        diff.removed.push({ key, value: oldContent[key] });
      }
    }

    // 修改的字段
    for (const key of oldKeys) {
      if (newKeys.has(key)) {
        const oldValue = JSON.stringify(oldContent[key]);
        const newValue = JSON.stringify(newContent[key]);
        if (oldValue !== newValue) {
          diff.modified.push({
            key,
            oldValue: oldContent[key],
            newValue: newContent[key],
          });
        }
      }
    }

    return diff;
  }

  /**
   * 生成 ID
   */
  private generateId(): string {
    return `sv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const specVersionService = new SpecVersionService();

// 单例导出
export function getSpecVersionService(): SpecVersionService {
  return specVersionService;
}
