/**
 * Spec 绕过审批服务
 * 
 * 负责：
 * 1. 创建绕过申请
 * 2. 审批绕过
 * 3. 补齐正式审批
 * 4. 查询待处理绕过
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { notificationService } from '@dommaker/studio-notification';

export interface CreateBypassInput {
  reason: string;
  urgency: 'critical' | 'high' | 'medium';
  requestedBy: string;
  requestedName?: string;
}

export interface ApproveBypassInput {
  bypassId: string;
  approvedBy: string;
  approvedName: string;
  approved: boolean;
  comment?: string;
}

export interface CompleteBypassInput {
  bypassId: string;
  specReviewId: string;
}

export class SpecBypassService {
  /**
   * 创建绕过申请
   */
  async createBypass(input: CreateBypassInput) {
    const bypass = await prisma.specBypass.create({
      data: {
        id: this.generateId(),
        reason: input.reason,
        urgency: input.urgency,
        requestedBy: input.requestedBy,
        requestedName: input.requestedName,
        status: 'pending',
      },
    });

    logger.info({ bypassId: bypass.id, urgency: input.urgency }, 'Spec bypass created');

    // 通知审批人（异步）
    this.notifyApprovers(bypass.id, input).catch(err => {
      logger.error({ err, bypassId: bypass.id }, 'Failed to notify approvers');
    });

    return bypass;
  }

  /**
   * 审批绕过申请
   */
  async approveBypass(input: ApproveBypassInput) {
    const bypass = await prisma.specBypass.findUnique({
      where: { id: input.bypassId },
    });

    if (!bypass) {
      throw new Error('绕过申请不存在');
    }

    if (bypass.status !== 'pending') {
      throw new Error('绕过申请已处理');
    }

    const newStatus = input.approved ? 'approved' : 'rejected';

    const updated = await prisma.specBypass.update({
      where: { id: input.bypassId },
      data: {
        status: newStatus,
        approvedBy: input.approvedBy,
        approvedName: input.approvedName,
        reviewedAt: new Date(),
        comment: input.comment,
      },
    });

    logger.info({
      bypassId: input.bypassId,
      approved: input.approved,
      status: newStatus,
    }, 'Bypass reviewed');

    // 通知申请人
    this.notifyRequester(updated, input).catch(err => {
      logger.error({ err, bypassId: input.bypassId }, 'Failed to notify requester');
    });

    return updated;
  }

  /**
   * 补齐正式审批
   */
  async completeBypass(input: CompleteBypassInput) {
    const bypass = await prisma.specBypass.findUnique({
      where: { id: input.bypassId },
    });

    if (!bypass) {
      throw new Error('绕过申请不存在');
    }

    if (bypass.status !== 'approved') {
      throw new Error('绕过申请未获批准，无法补齐');
    }

    if (bypass.completedAt) {
      throw new Error('绕过申请已补齐');
    }

    const updated = await prisma.specBypass.update({
      where: { id: input.bypassId },
      data: {
        specReviewId: input.specReviewId,
        completedAt: new Date(),
        status: 'completed',
      },
    });

    logger.info({
      bypassId: input.bypassId,
      specReviewId: input.specReviewId,
    }, 'Bypass completed with formal review');

    return updated;
  }

  /**
   * 获取待处理的绕过申请
   */
  async getPendingBypasses(options?: {
    limit?: number;
    offset?: number;
  }) {
    const [bypasses, total] = await Promise.all([
      prisma.specBypass.findMany({
        where: { status: 'pending' },
        orderBy: [
          { urgency: 'desc' },
          { createdAt: 'asc' },
        ],
        take: options?.limit || 50,
        skip: options?.offset || 0,
      }),
      prisma.specBypass.count({ where: { status: 'pending' } }),
    ]);

    return { bypasses, total };
  }

  /**
   * 获取待补齐的绕过申请
   */
  async getApprovedBypasses(options?: {
    requestedBy?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {
      status: 'approved',
      completedAt: null,
    };

    if (options?.requestedBy) {
      where.requestedBy = options.requestedBy;
    }

    const [bypasses, total] = await Promise.all([
      prisma.specBypass.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: options?.limit || 50,
        skip: options?.offset || 0,
        include: {
          specReview: true,
        },
      }),
      prisma.specBypass.count({ where }),
    ]);

    return { bypasses, total };
  }

  /**
   * 获取绕过申请详情
   */
  async getBypass(bypassId: string) {
    return prisma.specBypass.findUnique({
      where: { id: bypassId },
      include: {
        specReview: true,
      },
    });
  }

  /**
   * 获取绕过统计
   */
  async getBypassStats() {
    const [total, pending, approved, rejected, completed] = await Promise.all([
      prisma.specBypass.count(),
      prisma.specBypass.count({ where: { status: 'pending' } }),
      prisma.specBypass.count({ where: { status: 'approved' } }),
      prisma.specBypass.count({ where: { status: 'rejected' } }),
      prisma.specBypass.count({ where: { status: 'completed' } }),
    ]);

    const incomplete = await prisma.specBypass.count({
      where: {
        status: 'approved',
        completedAt: null,
      },
    });

    return {
      total,
      pending,
      approved,
      rejected,
      completed,
      incomplete, // 已批准但未补齐
    };
  }

  /**
   * 生成 ID
   */
  private generateId(): string {
    return `bp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 通知审批人
   */
  private async notifyApprovers(bypassId: string, input: CreateBypassInput) {
    // 通知架构师（简化实现）
    await notificationService.create({
      userId: 'architect',
      type: 'review_request',
      title: `紧急 Spec 绕过申请: ${input.urgency}`,
      content: input.reason,
      link: `/spec-bypass/${bypassId}`,
    });

    logger.info({ bypassId }, 'Approvers notified');
  }

  /**
   * 通知申请人
   */
  private async notifyRequester(bypass: any, input: ApproveBypassInput) {
    await notificationService.create({
      userId: bypass.requestedBy,
      type: input.approved ? 'review_approved' : 'review_rejected',
      title: input.approved ? '绕过申请已批准' : '绕过申请已拒绝',
      content: input.comment || (input.approved ? '您的绕过申请已获批准' : '您的绕过申请被拒绝'),
      link: `/spec-bypass/${bypass.id}`,
    });

    logger.info({ bypassId: bypass.id, requesterId: bypass.requestedBy }, 'Requester notified');
  }
}

export const specBypassService = new SpecBypassService();

// 单例导出函数
export function getSpecBypassService(): SpecBypassService {
  return specBypassService;
}
