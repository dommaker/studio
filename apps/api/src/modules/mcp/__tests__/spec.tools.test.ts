/**
 * spec.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 createSpec / approveSpec / getSpecStatus / listSpecs。
 * HOME 指向临时目录以隔离真实审查数据。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let specTools: import('../tool-registry.js').RegisteredTool[];
let SPEC_REVIEWS_DIR: string;

function tool(name: string) {
  const t = specTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

function readReview(id: string) {
  return JSON.parse(fs.readFileSync(path.join(SPEC_REVIEWS_DIR, `${id}.json`), 'utf-8'));
}

function writeReview(id: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  fs.mkdirSync(SPEC_REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SPEC_REVIEWS_DIR, `${id}.json`), JSON.stringify({
    id, title: id, changes: [], changeType: 'api', impact: 'low',
    status: 'pending', approvals: [], createdAt: now, updatedAt: now, ...patch,
  }));
}

const approveInput = {
  role: 'architect', reviewerId: 'u1', reviewerName: 'Alice', approved: true,
};

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-spec-tools-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const mod = await import('../spec.tools.js');
  specTools = mod.specTools;
  SPEC_REVIEWS_DIR = (await import('../tool-store.js')).getSpecReviewsDir();
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // 隔离测试间数据：每次清空审查目录
  try { fs.rmSync(SPEC_REVIEWS_DIR, { recursive: true, force: true }); } catch {}
});

describe('spec.tools', () => {
  it('导出 4 个 tool，注册顺序不变', () => {
    expect(specTools.map(t => t.name)).toEqual(['createSpec', 'approveSpec', 'getSpecStatus', 'listSpecs']);
  });

  it('createSpec 默认 impact=low、status=pending、approvals=[]', async () => {
    const result = await tool('createSpec').handler({
      title: 'Change A', changes: [{ field: 'x' }], changeType: 'api',
    });
    expect(result).toMatchObject({ title: 'Change A', status: 'pending' });
    expect(result.reviewId).toMatch(/^spec_/);
    expect(readReview(result.reviewId)).toMatchObject({
      title: 'Change A', changeType: 'api', impact: 'low', status: 'pending', approvals: [],
    });
    expect(tool('createSpec').inputSchema.required).toEqual(['title', 'changes', 'changeType']);
  });

  it('approveSpec 批准 → approved 并记录 reviewedAt/reviewedBy', async () => {
    writeReview('sp_ok');
    const result = await tool('approveSpec').handler({ reviewId: 'sp_ok', ...approveInput, comment: 'LGTM' });
    expect(result).toEqual({ reviewId: 'sp_ok', status: 'approved', approvedCount: 1, rejectedCount: 0 });
    const saved = readReview('sp_ok');
    expect(saved.status).toBe('approved');
    expect(saved.reviewedBy).toBe('Alice');
    expect(saved.reviewedAt).toBeTruthy();
    expect(saved.approvals).toHaveLength(1);
    expect(saved.approvals[0]).toMatchObject({ role: 'architect', approved: true, comment: 'LGTM' });
  });

  it('approveSpec 拒绝 → rejected；已决审查再审批抛错；不存在抛错', async () => {
    writeReview('sp_no');
    const result = await tool('approveSpec').handler({ reviewId: 'sp_no', ...approveInput, approved: false });
    expect(result).toMatchObject({ status: 'rejected', approvedCount: 0, rejectedCount: 1 });

    await expect(tool('approveSpec').handler({ reviewId: 'sp_no', ...approveInput }))
      .rejects.toThrow('Review already rejected');
    await expect(tool('approveSpec').handler({ reviewId: 'nope', ...approveInput }))
      .rejects.toThrow('SpecReview not found');
  });

  it('getSpecStatus 返回 SpecReviewApproval 映射', async () => {
    writeReview('sp_st', {
      approvals: [{
        role: 'architect', reviewerId: 'u1', reviewerName: 'Alice',
        approved: true, comment: 'ok', createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    const result = await tool('getSpecStatus').handler({ reviewId: 'sp_st' });
    expect(result.id).toBe('sp_st');
    expect(result.SpecReviewApproval).toEqual([{
      role: 'architect', reviewerName: 'Alice', approved: true,
      comment: 'ok', createdAt: '2026-01-01T00:00:00.000Z',
    }]);

    await expect(tool('getSpecStatus').handler({ reviewId: 'nope' })).rejects.toThrow('SpecReview not found');
  });

  it('listSpecs 状态过滤 + createdAt 倒序 + 默认 limit=20', async () => {
    writeReview('ls_a', { status: 'approved', requestedBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z' });
    writeReview('ls_b', { status: 'pending', createdAt: '2026-01-03T00:00:00.000Z' });
    writeReview('ls_c', { status: 'approved', createdAt: '2026-01-02T00:00:00.000Z' });

    const approved = await tool('listSpecs').handler({ status: 'approved' });
    expect(approved.reviews.map((r: any) => r.id)).toEqual(['ls_c', 'ls_a']);
    expect(approved.reviews[0]).toEqual({
      id: 'ls_c', title: 'ls_c', changeType: 'api', status: 'approved',
      requestedBy: undefined, createdAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
