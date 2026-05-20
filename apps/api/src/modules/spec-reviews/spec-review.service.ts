/**
 * Spec 审查服务
 * 
 * 负责：
 * 1. 创建审查
 * 2. 查询审查
 * 3. 提交审批
 * 4. 触发通知
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { notificationService } from '@dommaker/studio-notification';
import { roleService } from '../roles/role.service.js';

export interface SpecChange {
  type: 'architecture' | 'api' | 'data-model' | 'workflow' | 'step' | 'skill' | 'other';
  file: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  diff?: string;
}

export interface CreateReviewInput {
  workflowId?: string;
  title: string;
  description?: string;
  changes: SpecChange[];
  requestedBy?: string;
}

export interface ApprovalInput {
  reviewId: string;
  role: 'architect' | 'projectLead';
  reviewerId: string;
  reviewerName: string;
  approved: boolean;
  comment?: string;
}

export class SpecReviewService {
  /**
   * 创建审查
   */
  async createReview(input: CreateReviewInput) {
    // 分析变更类型和影响
    const changeType = this.analyzeChangeType(input.changes);
    const impact = this.analyzeImpact(input.changes);
    
    const review = await prisma.specReview.create({
      data: {
        id: this.generateId(),
        workflowId: input.workflowId,
        title: input.title,
        description: input.description,
        changes: input.changes as any,
        changeType,
        impact,
        status: 'pending',
        updatedAt: new Date(),
        approvals: {
          architect: { approved: false },
          projectLead: { approved: false },
        },
        requestedBy: input.requestedBy,
      },
    });

    logger.info('Spec review created', { reviewId: review.id, changeType, impact });
    
    // 触发通知（异步，不等待）
    this.notifyReviewers(review.id, input).catch(err => {
      logger.error('Failed to notify reviewers', { err, reviewId: review.id });
    });
    
    return review;
  }
  
  /**
   * 更新 SpecReview
   */
  async updateReview(reviewId: string, data: { status?: string }) {
    const review = await prisma.specReview.update({
      where: { id: reviewId },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });

    logger.info('SpecReview updated', { reviewId, updates: data });

    return review;
  }

  /**
   * 查询审查列表
   */
  async getReviews(options?: {
    workflowId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    
    if (options?.workflowId) {
      where.workflowId = options.workflowId;
    }
    
    if (options?.status) {
      where.status = options.status;
    }
    
    const [reviews, total] = await Promise.all([
      prisma.specReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options?.limit || 50,
        skip: options?.offset || 0,
        include: {
          SpecReviewApproval: true,
        },
      }),
      prisma.specReview.count({ where }),
    ]);
    
    return { reviews, total };
  }
  
  /**
   * 获取审查详情
   */
  async getReview(reviewId: string) {
    return prisma.specReview.findUnique({
      where: { id: reviewId },
      include: {
        SpecReviewApproval: true,
      },
    });
  }
  
  /**
   * 提交审批
   */
  async submitApproval(input: ApprovalInput) {
    const review = await prisma.specReview.findUnique({
      where: { id: input.reviewId },
    });
    
    if (!review) {
      throw new Error('审查不存在');
    }
    
    if (review.status !== 'pending') {
      throw new Error('审查已结束');
    }
    
    // 检查是否已经审批过
    const existingApproval = await prisma.specReviewApproval.findUnique({
      where: {
        reviewId_role: {
          reviewId: input.reviewId,
          role: input.role,
        },
      },
    });
    
    if (existingApproval) {
      throw new Error('该角色已审批过');
    }
    
    // 创建审批记录
    const approval = await prisma.specReviewApproval.create({
      data: {
        id: this.generateId(),
        reviewId: input.reviewId,
        role: input.role,
        reviewerId: input.reviewerId,
        reviewerName: input.reviewerName,
        approved: input.approved,
        comment: input.comment,
      },
    });
    
    // 更新审查状态
    const approvals = review.approvals as any;
    approvals[input.role] = {
      approved: input.approved,
      reviewerId: input.reviewerId,
      reviewerName: input.reviewerName,
      comment: input.comment,
      timestamp: new Date().toISOString(),
    };
    
    // 判断是否需要双签
    const needsDualSign = ['architecture', 'api', 'data-model'].includes(review.changeType);
    
    let newStatus = review.status;
    
    if (!input.approved) {
      // 拒绝
      newStatus = 'rejected';
    } else if (needsDualSign) {
      // 双签制：需要架构师和项目负责人都批准
      if (approvals.architect?.approved && approvals.projectLead?.approved) {
        newStatus = 'approved';
      }
    } else {
      // 单签制：任意一人批准即可
      newStatus = 'approved';
    }
    
    await prisma.specReview.update({
      where: { id: input.reviewId },
      data: {
        approvals,
        status: newStatus,
        reviewedAt: new Date(),
        reviewedBy: input.reviewerId,
        comment: input.comment,
      },
    });
    
    logger.info('Approval submitted', {
      reviewId: input.reviewId,
      role: input.role,
      approved: input.approved,
      newStatus,
    });
    
    return { approval, status: newStatus };
  }
  
  /**
   * 分析变更类型
   */
  private analyzeChangeType(changes: SpecChange[]): string {
    const priority = ['architecture', 'api', 'data-model', 'workflow', 'step', 'skill', 'other'];
    
    for (const type of priority) {
      if (changes.some(c => c.type === type)) {
        return type;
      }
    }
    
    return 'other';
  }
  
  /**
   * 分析影响级别
   */
  private analyzeImpact(changes: SpecChange[]): string {
    if (changes.some(c => c.impact === 'high')) {
      return 'high';
    }
    if (changes.some(c => c.impact === 'medium')) {
      return 'medium';
    }
    return 'low';
  }
  
  /**
   * 生成 ID
   */
  private generateId(): string {
    return `sr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  
  /**
   * 通知审查人
   */
  private async notifyReviewers(reviewId: string, input: CreateReviewInput) {
    // 创建站内通知
    // 🆕 AS-048: 动态获取项目负责人
    
    const reviewers: Array<{ userId: string; name: string }> = [
      { userId: 'architect', name: '架构师' },
    ];
    
    // 动态获取项目负责人
    try {
      const companyId = input.companyId || 'default-company';
      const projectLead = await roleService.getProjectLead(companyId);
      if (projectLead) {
        reviewers.push({
          userId: projectLead.id,
          name: projectLead.name,
        });
      } else {
        // 兜底：使用默认名称
        reviewers.push({ userId: 'project_lead', name: '项目负责人' });
      }
    } catch (err) {
      logger.warn('Failed to get project lead, using default', { err });
      reviewers.push({ userId: 'project_lead', name: '项目负责人' });
    }
    
    for (const reviewer of reviewers) {
      try {
        await notificationService.create({
          userId: reviewer.userId,
          type: 'review_request',
          title: `Spec 审查请求: ${input.title}`,
          content: input.description || `检测到 ${input.changes.length} 个变更需要审查`,
          link: `/workflows/${input.workflowId}?review=${reviewId}`,
        });
      } catch (err) {
        logger.error('Failed to send notification', { err, userId: reviewer.userId });
      }
    }
    
    logger.info('Reviewers notified', { reviewId, reviewerCount: reviewers.length });
  }
}

export const specReviewService = new SpecReviewService();
