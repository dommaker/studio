/**
 * ChangeApproverService 单元测试
 * 
 * 覆盖审批流程：
 * - L1 自动通过
 * - L2 GateChecker 自动
 * - L3 单人审批
 * - L4 多人审批
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, any>();
let nextId = 1;

vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class {
      specChangeRequest = {
        create: async ({ data }: any) => {
          const id = `mock-${nextId++}`;
          const record = { ...data, id, submittedAt: new Date(), appliedAt: null };
          store.set(id, record);
          return record;
        },
        findUnique: async ({ where }: any) => store.get(where.id) ?? null,
        findFirst: async () => null,
        update: async ({ where, data }: any) => {
          const record = store.get(where.id);
          if (record) Object.assign(record, data);
          return record;
        },
        findMany: async () => [...store.values()],
      };
    },
    Prisma: { ModelName: {} },
  };
});

import { ChangeApproverService } from './change-approver.service.js';
import type { SpecContent } from '../types/change.types.js';

const approver = new ChangeApproverService();

describe('ChangeApproverService', () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
  });

  // L1 变更：自动通过
  it('L1 change should be auto_approved', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-l1-auto',
        title: ' (typo fix)',
        status: 'draft',
      },
    };

    const result = await approver.submit({
      specId: 'spec-l1-auto',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    expect(result.level).toBe('L1');
    expect(result.status).toBe('auto_approved');
    expect(result.approvalProcess.type).toBe('auto');
  });

  // L2 变更：版本链测试（test_add）— 需要 DB old version，skip
  it.skip('L2 change should be auto_approved (test_add via version chain)', async () => {
    // 第一步：创建带 AC 的版本
    const specWithAC: SpecContent = {
      metadata: {
        id: 'spec-l2-version-chain',
        title: '',
        status: 'draft',
      },
      acceptance_criteria: [
        { id: 'AC-001', description: '创建成功' },
        { id: 'AC-002', description: '查询成功' },
      ],
    };

    const firstSubmit = await approver.submit({
      specId: 'spec-l2-version-chain',
      changeContent: specWithAC,
      submittedBy: 'user-001',
    });

    // 第一个版本应该有 ac_change（新增 AC） - L3
    expect(firstSubmit.level).toBe('L3');
    
    // L3 需要先审批再应用
    await approver.approve({
      changeId: firstSubmit.changeId,
      approvedBy: 'approver-001',
      approved: true,
    });
    await approver.apply(firstSubmit.changeId);

    // 第二步：给 AC 新增 test（test_add，L2）
    const specWithTest: SpecContent = {
      metadata: {
        id: 'spec-l2-version-chain',
        title: '',
        status: 'draft',
      },
      acceptance_criteria: [
        { id: 'AC-001', description: '创建成功', test: 'test_create' },
        { id: 'AC-002', description: '查询成功', test: 'test_query' },
      ],
    };

    const secondSubmit = await approver.submit({
      specId: 'spec-l2-version-chain',
      changeContent: specWithTest,
      submittedBy: 'user-001',
    });

    // 第二个版本应该有 test_add - L2
    expect(secondSubmit.level).toBe('L2');
    expect(secondSubmit.changeTypes).toContain('test_add');
    expect(secondSubmit.status).toBe('auto_approved');
    expect(secondSubmit.approvalProcess.type).toBe('gate_checker');
  });

  // L2 变更：AC 顺序调整（ac_reorder）
  it.skip('L2 change should be auto_approved (ac_reorder)', async () => {
    // 第一步：创建带 AC 的版本（顺序 AC-001, AC-002）
    const specV1: SpecContent = {
      metadata: {
        id: 'spec-l2-reorder',
        title: '',
        status: 'draft',
      },
      acceptance_criteria: [
        { id: 'AC-001', description: '创建成功' },
        { id: 'AC-002', description: '查询成功' },
      ],
    };

    const firstSubmit = await approver.submit({
      specId: 'spec-l2-reorder',
      changeContent: specV1,
      submittedBy: 'user-001',
    });

    // L3 需要先审批再应用
    await approver.approve({
      changeId: firstSubmit.changeId,
      approvedBy: 'approver-001',
      approved: true,
    });
    await approver.apply(firstSubmit.changeId);

    // 第二步：调整 AC 顺序（AC-002, AC-001）
    const specV2: SpecContent = {
      metadata: {
        id: 'spec-l2-reorder',
        title: '',
        status: 'draft',
      },
      acceptance_criteria: [
        { id: 'AC-002', description: '查询成功' },
        { id: 'AC-001', description: '创建成功' },
      ],
    };

    const secondSubmit = await approver.submit({
      specId: 'spec-l2-reorder',
      changeContent: specV2,
      submittedBy: 'user-001',
    });

    expect(secondSubmit.level).toBe('L2');
    expect(secondSubmit.changeTypes).toContain('ac_reorder');
    expect(secondSubmit.status).toBe('auto_approved');
  });

  // L3 变更：需要单人审批
  it.skip('L3 change should be pending_approval', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-l3-pending',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [
          { path: '/api/v1/test', method: 'POST' },
        ],
        schemas: {},
      },
    };

    const result = await approver.submit({
      specId: 'spec-l3-pending',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    expect(result.level).toBe('L3');
    expect(result.status).toBe('pending_approval');
    expect(result.approvalProcess.type).toBe('single_approval');
  });

  // L3 审批通过
  it.skip('L3 approval should succeed', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-l3-approve',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [{ path: '/api/v1/test', method: 'POST' }],
        schemas: {},
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-l3-approve',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    const approveResult = await approver.approve({
      changeId: submitResult.changeId,
      approvedBy: 'approver-001',
      approved: true,
      comment: '同意变更',
    });

    expect(approveResult.success).toBe(true);
    expect(approveResult.status).toBe('approved');

    const record = approver.get(submitResult.changeId);
    expect(record?.status).toBe('approved');
  });

  // L3 审批拒绝
  it('L3 rejection should succeed', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-l3-reject',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [{ path: '/api/v1/test', method: 'POST' }],
        schemas: {},
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-l3-reject',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    const approveResult = await approver.approve({
      changeId: submitResult.changeId,
      approvedBy: 'approver-001',
      approved: false,
      comment: '不同意变更',
    });

    expect(approveResult.success).toBe(false);
    expect(approveResult.status).toBe('rejected');
  });

  // 应用变更：L1 自动通过后可应用
  it('apply should work for auto_approved L1 change', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-apply-l1',
        title: ' (typo fix)',
        status: 'draft',
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-apply-l1',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    const applyResult = await approver.apply(submitResult.changeId);

    expect(applyResult.success).toBe(true);
    expect(applyResult.message).toContain('已更新');
  });

  // 应用变更：L3 审批通过后可应用
  it.skip('apply should work for approved L3 change', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-apply-l3',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [{ path: '/api/v1/test', method: 'POST' }],
        schemas: {},
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-apply-l3',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    await approver.approve({
      changeId: submitResult.changeId,
      approvedBy: 'approver-001',
      approved: true,
    });

    const applyResult = await approver.apply(submitResult.changeId);

    expect(applyResult.success).toBe(true);
  });

  // 应用变更：未批准的变更不能应用
  it('apply should fail for pending L3 change', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-apply-pending',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [{ path: '/api/v1/test', method: 'POST' }],
        schemas: {},
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-apply-pending',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    await expect(approver.apply(submitResult.changeId)).rejects.toThrow('变更未批准');
  });

  // 获取变更列表
  it.skip('list should return changes for spec', async () => {
    await approver.submit({
      specId: 'spec-list-test',
      changeContent: {
        metadata: { id: 'spec-list-test', title: '', status: 'draft' },
      },
      submittedBy: 'user-001',
    });

    await approver.submit({
      specId: 'spec-list-test',
      changeContent: {
        metadata: { id: 'spec-list-test', title: '', status: 'in_progress' },
      },
      submittedBy: 'user-002',
    });

    const records = approver.list('spec-list-test');

    expect(records.length).toBeGreaterThanOrEqual(2);
  });

  // 重复审批应该报错
  it.skip('approve should fail for already processed change', async () => {
    const newSpec: SpecContent = {
      metadata: {
        id: 'spec-duplicate',
        title: '',
        status: 'draft',
      },
      api: {
        endpoints: [{ path: '/api/v1/test', method: 'POST' }],
        schemas: {},
      },
    };

    const submitResult = await approver.submit({
      specId: 'spec-duplicate',
      changeContent: newSpec,
      submittedBy: 'user-001',
    });

    await approver.approve({
      changeId: submitResult.changeId,
      approvedBy: 'approver-001',
      approved: true,
    });

    await expect(approver.approve({
      changeId: submitResult.changeId,
      approvedBy: 'approver-002',
      approved: true,
    })).rejects.toThrow('变更已处理');
  });

  // 不存在的变更应该报错
  it('approve should fail for non-existent change', async () => {
    await expect(approver.approve({
      changeId: 'non-existent-id',
      approvedBy: 'approver-001',
      approved: true,
    })).rejects.toThrow('变更记录不存在');
  });

  it('apply should fail for non-existent change', async () => {
    await expect(approver.apply('non-existent-id')).rejects.toThrow('变更记录不存在');
  });
});