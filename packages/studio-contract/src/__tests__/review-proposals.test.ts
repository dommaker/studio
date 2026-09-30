/**
 * review-proposal 域契约测试：状态词表/params/响应 schema 的接受-拒绝边界 +
 * ReviewProposalApproveResult parity。正本 = review-proposal/routes.ts 实测 wire、
 * store.ts 状态词表。
 */

import { describe, it, expect } from 'vitest';
import {
  reviewProposalStatusSchema,
  reviewProposalStatusValueSchema,
  reviewProposalParamsSchema,
  reviewProposalApproveResultSchema,
  type ReviewProposalApproveResult,
  reviewProposalRejectResultSchema,
  reviewProposalStatusResultSchema,
  reviewProposalApproveResponseSchema,
  reviewProposalRejectResponseSchema,
  reviewProposalStatusResponseSchema,
} from '../review-proposals.js';
import * as contractIndex from '../index.js';

const approveRow: ReviewProposalApproveResult = {
  success: true,
  productIds: ['p1'],
};

describe('状态词表', () => {
  it('正本词表 = pending/executed/rejected/failed/card-failed + stale（evolution 读侧归一）', () => {
    for (const s of ['pending', 'executed', 'rejected', 'failed', 'card-failed', 'stale']) {
      expect(reviewProposalStatusSchema.parse(s)).toBe(s);
    }
    // role-memory 旧 promoted 墓碑读取时已归一为 executed，promoted 不在词表
    expect(() => reviewProposalStatusSchema.parse('promoted')).toThrow();
    expect(() => reviewProposalStatusSchema.parse('unknown')).toThrow();
  });

  it('status 响应值域 = 正本词表 + unknown（查无此提案）', () => {
    expect(reviewProposalStatusValueSchema.parse('unknown')).toBe('unknown');
    expect(reviewProposalStatusValueSchema.parse('executed')).toBe('executed');
    expect(() => reviewProposalStatusValueSchema.parse('bogus')).toThrow();
  });
});

describe('reviewProposalParamsSchema', () => {
  it('kind/id 必填非空', () => {
    expect(reviewProposalParamsSchema.parse({ kind: 'distill', id: 'dp-1' }).kind).toBe('distill');
    expect(() => reviewProposalParamsSchema.parse({ kind: '', id: 'x' })).toThrow();
    expect(() => reviewProposalParamsSchema.parse({ kind: 'distill' })).toThrow();
  });
});

describe('approve/reject/status 响应 data', () => {
  it('parity：approve executed 形状（success:true + adapter data 透传）', () => {
    expect(reviewProposalApproveResultSchema.parse(approveRow)).toEqual(approveRow);
    // per-kind 扩展键透传（archivedIds/promoted/workUnitId/constraintId/proposalId 等）
    expect(reviewProposalApproveResultSchema.parse({ success: true, workUnitId: 'wu-1', promoted: 2 }).promoted).toBe(2);
    expect(() => reviewProposalApproveResultSchema.parse({ productIds: [] })).toThrow(); // success 必填
  });

  it('approve skipped（预算熔断 200）形状', () => {
    const skipped: ReviewProposalApproveResult = { success: false, skipped: 'budget-exhausted' };
    expect(reviewProposalApproveResultSchema.parse(skipped)).toEqual(skipped);
  });

  it('reject / status 形状（status 的 success 标志已退役）', () => {
    expect(reviewProposalRejectResultSchema.parse({ success: true }).success).toBe(true);
    expect(reviewProposalStatusResultSchema.parse({ status: 'pending' }).status).toBe('pending');
    expect(reviewProposalStatusResultSchema.parse({ status: 'unknown' }).status).toBe('unknown');
    expect(() => reviewProposalStatusResultSchema.parse({ status: 'promoted' })).toThrow();
  });
});

describe('响应壳', () => {
  it('approve/reject/status 响应 = { data } 壳', () => {
    expect(reviewProposalApproveResponseSchema.parse({ data: approveRow }).data.success).toBe(true);
    expect(reviewProposalRejectResponseSchema.parse({ data: { success: true } }).data.success).toBe(true);
    expect(reviewProposalStatusResponseSchema.parse({ data: { status: 'rejected' } }).data.status).toBe('rejected');
  });
});

describe('index.ts 出口', () => {
  it('review-proposal 域 schema 经 index 导出', () => {
    expect(contractIndex.reviewProposalStatusSchema).toBeDefined();
    expect(contractIndex.reviewProposalParamsSchema).toBeDefined();
    expect(contractIndex.reviewProposalApproveResponseSchema).toBeDefined();
  });
});
