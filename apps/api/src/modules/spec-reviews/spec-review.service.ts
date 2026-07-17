/**
 * Spec 审查服务
 *
 * 存储迁移: Prisma → FileStore (~/.studio/data/spec-reviews/)
 *
 * 负责：
 * 1. 创建审查
 * 2. 查询审查
 * 3. 提交审批
 * 4. 触发通知
 */

import { FileStore, logger } from '@dommaker/studio-shared';
import { notificationService } from '@dommaker/studio-notification';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const SPEC_REVIEWS_DIR = path.join(os.homedir(), '.studio', 'data', 'spec-reviews');
const fileStore = new FileStore();

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

// ─── 存储类型 ───

interface SpecReviewRecord {
  id: string;
  title: string;
  description?: string;
  changes: SpecChange[];
  changeType: string;
  impact: string;
  status: string;
  requestedBy?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  comment?: string;
  approvals: Record<string, { approved: boolean; reviewerId?: string; reviewerName?: string; comment?: string; timestamp?: string }>;
  specReviewApprovals: SpecReviewApprovalRecord[];
  createdAt: string;
  updatedAt: string;
}

interface SpecReviewApprovalRecord {
  id: string;
  reviewId: string;
  role: string;
  reviewerId: string;
  reviewerName: string;
  approved: boolean;
  comment?: string;
  createdAt: string;
}

function reviewPath(id: string): string {
  return path.join(SPEC_REVIEWS_DIR, `${id}.json`);
}

async function readReview(id: string): Promise<SpecReviewRecord | null> {
  return fileStore.readJson<SpecReviewRecord>(reviewPath(id));
}

async function writeReview(data: SpecReviewRecord): Promise<void> {
  await ensureDir(SPEC_REVIEWS_DIR);
  await fileStore.writeJson(reviewPath(data.id), data);
}

async function listReviews(): Promise<SpecReviewRecord[]> {
  try {
    const entries = await fs.promises.readdir(SPEC_REVIEWS_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const results: SpecReviewRecord[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<SpecReviewRecord>(path.join(SPEC_REVIEWS_DIR, f.name));
      if (data) results.push(data);
    }
    return results;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface SpecChange {
  type: 'architecture' | 'api' | 'data-model' | 'workflow' | 'step' | 'skill' | 'other';
  file: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  diff?: string;
}

export interface CreateReviewInput {
  title: string;
  description?: string;
  changes: SpecChange[];
  requestedBy?: string;
  companyId?: string;
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

    const now = new Date().toISOString();
    const review: SpecReviewRecord = {
      id: this.generateId(),
      title: input.title,
      description: input.description,
      changes: input.changes,
      changeType,
      impact,
      status: 'pending',
      requestedBy: input.requestedBy,
      approvals: {
        architect: { approved: false },
        projectLead: { approved: false },
      },
      specReviewApprovals: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeReview(review);

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
    const existing = await readReview(reviewId);
    if (!existing) throw new Error('Review not found');

    const review: SpecReviewRecord = { ...existing, ...data, updatedAt: new Date().toISOString() };
    await writeReview(review);

    logger.info('SpecReview updated', { reviewId, updates: data });

    return review;
  }

  /**
   * 查询审查列表
   */
  async getReviews(options?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    let reviews = await listReviews();

    if (options?.status) {
      reviews = reviews.filter(r => r.status === options.status);
    }

    reviews.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = reviews.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;
    const paged = reviews.slice(offset, offset + limit);

    // Map to include SpecReviewApproval as expected by callers
    const mapped = paged.map(r => ({
      ...r,
      SpecReviewApproval: r.specReviewApprovals,
    }));

    return { reviews: mapped, total };
  }

  /**
   * 获取审查详情
   */
  async getReview(reviewId: string) {
    const review = await readReview(reviewId);
    if (!review) return null;
    return { ...review, SpecReviewApproval: review.specReviewApprovals };
  }
  
  /**
   * 提交审批
   */
  async submitApproval(input: ApprovalInput) {
    const review = await readReview(input.reviewId);

    if (!review) {
      throw new Error('审查不存在');
    }

    if (review.status !== 'pending') {
      throw new Error('审查已结束');
    }

    // 检查是否已经审批过
    const existingApproval = review.specReviewApprovals.find(a => a.reviewId === input.reviewId && a.role === input.role);
    if (existingApproval) {
      throw new Error('该角色已审批过');
    }

    // 创建审批记录
    const now = new Date().toISOString();
    const approval: SpecReviewApprovalRecord = {
      id: this.generateId(),
      reviewId: input.reviewId,
      role: input.role,
      reviewerId: input.reviewerId,
      reviewerName: input.reviewerName,
      approved: input.approved,
      comment: input.comment,
      createdAt: now,
    };
    review.specReviewApprovals.push(approval);

    // 更新审查 approvals 状态对象
    review.approvals[input.role] = {
      approved: input.approved,
      reviewerId: input.reviewerId,
      reviewerName: input.reviewerName,
      comment: input.comment,
      timestamp: now,
    };

    // 判断是否需要双签
    const needsDualSign = ['architecture', 'api', 'data-model'].includes(review.changeType);

    let newStatus = review.status;

    if (!input.approved) {
      // 拒绝
      newStatus = 'rejected';
    } else if (needsDualSign) {
      // 双签制：需要架构师和项目负责人都批准
      if (review.approvals.architect?.approved && review.approvals.projectLead?.approved) {
        newStatus = 'approved';
      }
    } else {
      // 单签制：任意一人批准即可
      newStatus = 'approved';
    }

    review.status = newStatus;
    review.reviewedAt = now;
    review.reviewedBy = input.reviewerId;
    review.comment = input.comment;
    review.updatedAt = now;
    await writeReview(review);

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

    // 使用默认项目负责人（Role 功能已废弃）
    reviewers.push({ userId: 'project_lead', name: '项目负责人' });
    
    for (const reviewer of reviewers) {
      try {
        await notificationService.create({
          userId: reviewer.userId,
          type: 'review_request',
          title: `Spec 审查请求: ${input.title}`,
          content: input.description || `检测到 ${input.changes.length} 个变更需要审查`,
          link: `/reviews/${reviewId}`,
        });
      } catch (err) {
        logger.error('Failed to send notification', { err, userId: reviewer.userId });
      }
    }
    
    logger.info('Reviewers notified', { reviewId, reviewerCount: reviewers.length });
  }
}

export const specReviewService = new SpecReviewService();
