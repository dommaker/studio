/**
 * MCP Tools — 规格审查（FileStore）
 *
 * T3 拆分：自 tools.ts 原样提取（createSpec / approveSpec / getSpecStatus / listSpecs）。
 */

import type { RegisteredTool } from './tool-registry.js';
import {
  getSpecReviewsDir,
  generateId,
  getEntity,
  listJsonFiles,
  writeEntity,
} from './tool-store.js';

// ─── 规格审查（FileStore） ───

interface SpecReviewData {
  id: string;
  title: string;
  description?: string;
  changes: Array<Record<string, unknown>>;
  changeType: string;
  impact: string;
  requestedBy?: string;
  status: string;
  reviewedAt?: string;
  reviewedBy?: string;
  approvals: Array<{
    role: string;
    reviewerId: string;
    reviewerName: string;
    approved: boolean;
    comment?: string;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

const createSpec: RegisteredTool = {
  name: 'createSpec',
  description: '创建规格变更审查',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '变更标题' },
      description: { type: 'string', description: '变更描述' },
      changes: { type: 'array', items: { type: 'object' }, description: '变更内容列表' },
      changeType: { type: 'string', description: '变更类型' },
      impact: { type: 'string', description: '影响评估' },
      requestedBy: { type: 'string', description: '请求者' },
    },
    required: ['title', 'changes', 'changeType'],
  },
  handler: async (input) => {
    const id = `spec_${generateId()}`;
    const now = new Date().toISOString();
    const review: SpecReviewData = {
      id,
      title: input.title,
      description: input.description,
      changes: input.changes,
      changeType: input.changeType,
      impact: input.impact || 'low',
      requestedBy: input.requestedBy,
      status: 'pending',
      approvals: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeEntity(getSpecReviewsDir(), id, review);
    return { reviewId: review.id, title: review.title, status: review.status };
  },
};

const approveSpec: RegisteredTool = {
  name: 'approveSpec',
  description: '审批规格变更',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string', description: '审查 ID' },
      role: { type: 'string', description: '审批角色', enum: ['architect', 'projectLead'] },
      reviewerId: { type: 'string', description: '审批者 ID' },
      reviewerName: { type: 'string', description: '审批者名称' },
      approved: { type: 'boolean', description: '是否通过' },
      comment: { type: 'string', description: '审批意见' },
    },
    required: ['reviewId', 'role', 'reviewerId', 'reviewerName', 'approved'],
  },
  handler: async (input) => {
    const review = await getEntity<SpecReviewData>(getSpecReviewsDir(), input.reviewId);
    if (!review) throw new Error('SpecReview not found');
    if (review.status !== 'pending') throw new Error(`Review already ${review.status}`);

    const now = new Date().toISOString();
    const approval = {
      role: input.role,
      reviewerId: input.reviewerId,
      reviewerName: input.reviewerName,
      approved: input.approved,
      comment: input.comment,
      createdAt: now,
    };
    const approvals = [...review.approvals, approval];
    const approvedCount = approvals.filter(a => a.approved).length;
    const rejectedCount = approvals.filter(a => !a.approved).length;

    let newStatus = 'pending';
    if (rejectedCount > 0) {
      newStatus = 'rejected';
    } else if (approvedCount >= 1) {
      newStatus = 'approved';
    }

    const updated: SpecReviewData = {
      ...review,
      status: newStatus,
      approvals,
      ...(newStatus !== 'pending' ? { reviewedAt: now, reviewedBy: input.reviewerName } : {}),
      updatedAt: now,
    };
    await writeEntity(getSpecReviewsDir(), input.reviewId, updated);

    return { reviewId: updated.id, status: updated.status, approvedCount, rejectedCount };
  },
};

const getSpecStatus: RegisteredTool = {
  name: 'getSpecStatus',
  description: '获取规格审查状态',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string', description: '审查 ID' },
    },
    required: ['reviewId'],
  },
  handler: async (input) => {
    const review = await getEntity<SpecReviewData>(getSpecReviewsDir(), input.reviewId);
    if (!review) throw new Error('SpecReview not found');
    const { SpecReviewApproval } = review as unknown as { SpecReviewApproval?: unknown };
    return {
      ...review,
      SpecReviewApproval: SpecReviewApproval ?? review.approvals.map(a => ({
        role: a.role,
        reviewerName: a.reviewerName,
        approved: a.approved,
        comment: a.comment,
        createdAt: a.createdAt,
      })),
    };
  },
};

const listSpecs: RegisteredTool = {
  name: 'listSpecs',
  description: '列出规格审查',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '状态过滤', enum: ['pending', 'approved', 'rejected', 'applied'] },
      limit: { type: 'number', description: '返回数量', default: 20 },
    },
  },
  handler: async (input) => {
    let reviews = await listJsonFiles<SpecReviewData>(getSpecReviewsDir());
    if (input.status) reviews = reviews.filter(r => r.status === input.status);
    reviews.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const subset = reviews.slice(0, input.limit || 20).map(r => ({
      id: r.id, title: r.title, changeType: r.changeType, status: r.status, requestedBy: r.requestedBy, createdAt: r.createdAt,
    }));
    return { reviews: subset, total: subset.length };
  },
};

export const specTools: RegisteredTool[] = [
  createSpec,
  approveSpec,
  getSpecStatus,
  listSpecs,
];
