/**
 * pmo 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 + 手写 interface parity。
 * 正本 = project.service.ts ProjectData / okr.service.ts / delivery.ts + 路由实测 wire 行为。
 */

import { describe, it, expect } from 'vitest';
import {
  projectSchema,
  type Project,
  pmoMapSchema,
  type PmoMap,
  pmoDecisionSchema,
  type PmoDecision,
  fogItemSchema,
  type FogItem,
  deliveryLegSchema,
  okrSchema,
  type Okr,
  okrDetailSchema,
  okrMutationResultSchema,
  deliveryStatusSchema,
  type DeliveryStatus,
  legDeliverResultSchema,
  deliverResultSchema,
  markDeliveredResultSchema,
  parsePmoCommandResultSchema,
  publishProjectResultSchema,
  linkedSddsResultSchema,
  listProjectsQuerySchema,
  listOkrsQuerySchema,
  projectIdParamsSchema,
  pmoNumberParamsSchema,
  okrIdParamsSchema,
  createProjectBodySchema,
  updateProjectBodySchema,
  updateProjectStatusBodySchema,
  publishProjectBodySchema,
  parsePmoCommandBodySchema,
  markDeliveredBodySchema,
  createOkrBodySchema,
  updateOkrBodySchema,
  projectListResponseSchema,
  projectResponseSchema,
  deliveryStatusResponseSchema,
  deleteOkrResultSchema,
} from '../pmo.js';
import * as contractIndex from '../index.js';

/** 后端 ProjectData 全字段最小合法形状（读取路径已合成 deliveries 单腿） */
const projectRow: Project = {
  id: 'proj-1',
  pmoNumber: 'PMO-1',
  title: '证据链看板',
  description: null,
  requirement: null,
  companyId: null,
  okrId: null,
  status: 'pending',
  priority: 'normal',
  progress: 0,
  gitBranch: 'PMO-1',
  gitRepo: null,
  specFilePath: null,
  requirementsDocId: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const okrRow: Okr = {
  id: 'okr_1',
  companyId: 'co-1',
  title: 'Q3 增长',
  quarter: '2026-Q3',
  status: 'active',
  progress: 0.5,
  objectives: [{ id: 'o1', title: 'O1' }],
  keyResults: [{ id: 'kr1', objectiveId: 'o1', title: 'KR1', target: 100, current: 50, unit: '%' }],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  projectCount: 2,
};

const deliveryRow: DeliveryStatus = {
  projectId: 'proj-1',
  pmoNumber: 'PMO-1',
  branch: 'PMO-1',
  policy: 'auto-merge',
  gitRepo: '/root/projects/studio',
  wu: { total: 3, finished: 2, inFlight: 1, byStatus: { unassigned: 0, active: 1, inReview: 0, blocked: 0 } },
  evidence: { l1Missing: [], l2Missing: ['WU-3'], l3Missing: [], selfReviewCount: 1 },
  deliverable: false,
  missing: ['WU-3 缺 L2'],
  tokens: 1234,
  archived: false,
  gaps: [{ id: 'WU-3', title: 't', type: 'task', missing: ['l2'] }],
  deliveredAt: null,
  deliveredBy: null,
  deliverCommit: null,
  channelId: null,
};

describe('projectSchema', () => {
  it('接受后端 wire 形状（含可选字段）', () => {
    expect(projectSchema.parse(projectRow)).toEqual(projectRow);
    expect(projectSchema.parse({
      ...projectRow,
      reqAlias: 'REQ-0001',
      deliveryPolicy: 'branch-only',
      isChore: true,
      channelId: 'ch-1',
      deliveries: [{ gitRepo: '/r', branch: 'PMO-1', status: 'pending' }],
      map: { destination: 'd', decisions: [], fog: [] },
    }).deliveries).toHaveLength(1);
  });

  it('缺必填字段 → 拒绝；deliveryPolicy 非法值 → 拒绝', () => {
    const { title: _t, ...noTitle } = projectRow;
    expect(projectSchema.safeParse(noTitle).success).toBe(false);
    expect(projectSchema.safeParse({ ...projectRow, deliveryPolicy: 'yolo' }).success).toBe(false);
  });

  // strict:false 仓 z.infer 全字段退化可选 → Project 是手写 interface；parity 兜漂移
  it('parity：Project interface fixture 全键 = schema.shape 键且通过校验', () => {
    const full: Project = {
      ...projectRow,
      reqAlias: 'REQ-0001',
      deliveryPolicy: 'auto-merge',
      isChore: false,
      channelId: 'ch-1',
      deliveredAt: '2026-09-02T00:00:00.000Z',
      deliveredBy: 'human',
      deliverCommit: 'c0ffee',
      map: { destination: 'd', decisions: [{ wuId: 'w', summary: 's', resolvedAt: 't' }], fog: [{ id: 'f', question: 'q', wuId: null, status: 'open' }] },
      deliveries: [{ gitRepo: '/r', branch: 'PMO-1', status: 'delivered', deliveredAt: 't', deliverCommit: 'c' }],
    };
    expect(projectSchema.parse(full)).toEqual(full);
    expect(Object.keys(projectSchema.shape).sort()).toEqual(Object.keys(full).sort());
  });

  it('parity：interface 必填字段逐一删除 → schema 拒绝（必填集对齐）', () => {
    for (const key of Object.keys(projectRow)) {
      const { [key]: _drop, ...rest } = projectRow as Record<string, unknown>;
      expect(projectSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });

  it('嵌套形状：pmoMap / deliveryLeg 词表', () => {
    expect(pmoMapSchema.safeParse({ destination: 'd', decisions: [], fog: [{ id: 'f', question: 'q', wuId: null, status: 'bogus' }] }).success).toBe(false);
    expect(pmoMapSchema.parse({ destination: 'd', decisions: [], fog: [], specSpawnedAt: 't', specWuId: null }).specWuId).toBeNull();
    expect(deliveryLegSchema.safeParse({ gitRepo: null, branch: null, status: 'bogus' }).success).toBe(false);
  });

  it('parity：PmoMap/FogItem/PmoDecision 手写 interface（前后端均按必填消费）↔ schema 互验', () => {
    const map: PmoMap = {
      destination: 'd',
      decisions: [{ wuId: 'w', summary: 's', resolvedAt: 't' }],
      fog: [{ id: 'f', question: 'q', wuId: null, status: 'open' }],
      specSpawnedAt: 't2',
      specWuId: null,
    };
    expect(pmoMapSchema.parse(map)).toEqual(map);
    expect(Object.keys(pmoMapSchema.shape).sort()).toEqual(Object.keys(map).sort());
    const fog: FogItem = { id: 'f', question: 'q', wuId: 'w', status: 'resolved' };
    expect(Object.keys(fogItemSchema.shape).sort()).toEqual(Object.keys(fog).sort());
    for (const key of Object.keys(fog)) {
      const { [key]: _drop, ...rest } = fog as unknown as Record<string, unknown>;
      expect(fogItemSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
    const decision: PmoDecision = { wuId: 'w', summary: 's', resolvedAt: 't' };
    expect(Object.keys(pmoDecisionSchema.shape).sort()).toEqual(Object.keys(decision).sort());
    for (const key of Object.keys(decision)) {
      const { [key]: _drop, ...rest } = decision as Record<string, unknown>;
      expect(pmoDecisionSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('okrSchema', () => {
  it('parity：Okr interface fixture 全键 = schema.shape 键；必填字段删除即拒', () => {
    expect(okrSchema.parse(okrRow)).toEqual(okrRow);
    expect(Object.keys(okrSchema.shape).sort()).toEqual(Object.keys(okrRow).sort());
    for (const key of Object.keys(okrRow)) {
      const { [key]: _drop, ...rest } = okrRow as Record<string, unknown>;
      expect(okrSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });

  it('detail / mutation 形状：detail 带 Company null + Execution + _count；mutation 无 projectCount', () => {
    const { projectCount: _p, ...mutation } = okrRow;
    expect(okrMutationResultSchema.parse(mutation)).toEqual(mutation);
    expect(okrDetailSchema.parse({ ...mutation, Company: null, Execution: [{ id: 'e1' }], _count: { Execution: 1 } })).toBeTruthy();
    expect(okrDetailSchema.safeParse({ ...mutation, Company: {}, Execution: [], _count: { Execution: 0 } }).success).toBe(false);
  });
});

describe('deliveryStatusSchema', () => {
  it('parity：DeliveryStatus interface fixture 全键 = schema.shape 键且通过校验', () => {
    const full: DeliveryStatus = {
      ...deliveryRow,
      legs: [{
        gitRepo: '/r', branch: 'PMO-1', status: 'completed', deliveredAt: null, deliverCommit: null,
        wu: deliveryRow.wu, evidence: deliveryRow.evidence, deliverable: true, missing: [], gaps: [], tokens: 1,
      }],
    };
    expect(deliveryStatusSchema.parse(full)).toEqual(full);
    expect(deliveryStatusSchema.parse(deliveryRow)).toEqual(deliveryRow);
    expect(Object.keys(deliveryStatusSchema.shape).sort()).toEqual(Object.keys(full).sort());
  });

  it('必填字段删除即拒；gaps.missing 词表校验', () => {
    for (const key of Object.keys(deliveryRow)) {
      const { [key]: _drop, ...rest } = deliveryRow as Record<string, unknown>;
      expect(deliveryStatusSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
    expect(deliveryStatusSchema.safeParse({
      ...deliveryRow, gaps: [{ id: 'w', title: 't', type: 'task', missing: ['l4'] }],
    }).success).toBe(false);
  });

  it('deliver / mark-delivered 成功结果形状', () => {
    expect(deliverResultSchema.parse({ delivered: true, deliverCommit: 'c0ffee' })).toBeTruthy();
    expect(deliverResultSchema.safeParse({ delivered: false, deliverCommit: 'c' }).success).toBe(false);
    expect(legDeliverResultSchema.parse({ gitRepo: null, branch: 'b', delivered: false, reason: 'skipped-no-wu' })).toBeTruthy();
    expect(legDeliverResultSchema.safeParse({ gitRepo: null, branch: 'b', delivered: false, reason: 'bogus' }).success).toBe(false);
    expect(markDeliveredResultSchema.parse({ delivered: true, deliverCommit: 'c', deliveredAt: 't' })).toBeTruthy();
  });
});

describe('请求 schema', () => {
  it('create project body：title 必填；gitRepos 字符串数组；deliveryPolicy 枚举', () => {
    expect(createProjectBodySchema.parse({ title: 't' })).toEqual({ title: 't' });
    expect(createProjectBodySchema.safeParse({}).success).toBe(false);
    expect(createProjectBodySchema.safeParse({ title: '' }).success).toBe(false);
    expect(createProjectBodySchema.safeParse({ title: 't', gitRepos: 'x' }).success).toBe(false);
    expect(createProjectBodySchema.safeParse({ title: 't', gitRepos: [1] }).success).toBe(false);
    expect(createProjectBodySchema.parse({ title: 't', gitRepos: [] }).gitRepos).toEqual([]);
    expect(createProjectBodySchema.safeParse({ title: 't', deliveryPolicy: 'bogus' }).success).toBe(false);
    expect(createProjectBodySchema.parse({ title: 't', deliveryPolicy: 'auto-merge' }).deliveryPolicy).toBe('auto-merge');
  });

  it('update project body：全可选 + passthrough（service 整体展开的旧行为不变）', () => {
    expect(updateProjectBodySchema.parse({})).toEqual({});
    expect(updateProjectBodySchema.parse({ status: 'active', 任意键: 1 })).toEqual({ status: 'active', 任意键: 1 });
    expect(updateProjectBodySchema.safeParse({ progress: '60' }).success).toBe(false);
    expect(updateProjectBodySchema.parse({ deliveredAt: null, map: null })).toEqual({ deliveredAt: null, map: null });
  });

  it('status / publish / parse-command / mark-delivered body 边界', () => {
    expect(updateProjectStatusBodySchema.parse({ status: 'active' })).toEqual({ status: 'active' });
    expect(updateProjectStatusBodySchema.safeParse({}).success).toBe(false);
    expect(publishProjectBodySchema.parse({ channelId: 'ch-1' })).toEqual({ channelId: 'ch-1' });
    expect(publishProjectBodySchema.parse({ channelId: 'ch-1', assigneeId: 'p-1' }).assigneeId).toBe('p-1');
    expect(publishProjectBodySchema.safeParse({}).success).toBe(false);
    expect(parsePmoCommandBodySchema.safeParse({ command: '' }).success).toBe(false);
    expect(markDeliveredBodySchema.parse({ commit: '  c0ffee  ' }).commit).toBe('c0ffee');
    expect(markDeliveredBodySchema.safeParse({ commit: '   ' }).success).toBe(false);
    expect(markDeliveredBodySchema.safeParse({ commit: 123 }).success).toBe(false);
  });

  it('okr body：create 必填四键（缺省原 500 收紧 400）；update 全可选', () => {
    expect(createOkrBodySchema.safeParse({ title: 't', quarter: '2026-Q3' }).success).toBe(false);
    expect(createOkrBodySchema.parse({
      title: 't', quarter: '2026-Q3', objectives: [{ id: 'o1', title: 'O' }], keyResults: [],
    })).toBeTruthy();
    expect(createOkrBodySchema.safeParse({ title: 't', quarter: '2026-Q3', objectives: [{ id: 'o1' }], keyResults: [] }).success).toBe(false);
    expect(updateOkrBodySchema.parse({})).toEqual({});
    expect(updateOkrBodySchema.parse({ title: 'x', status: 'archived' })).toEqual({ title: 'x', status: 'archived' });
  });

  it('query / params 边界', () => {
    expect(listProjectsQuerySchema.parse({})).toEqual({});
    expect(listProjectsQuerySchema.parse({ status: 'active', limit: '100' }).limit).toBe('100');
    expect(listOkrsQuerySchema.safeParse({}).success).toBe(false);
    expect(listOkrsQuerySchema.parse({ companyId: 'co-1', status: 'active' })).toBeTruthy();
    expect(projectIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(pmoNumberParamsSchema.parse({ pmoNumber: 'PMO-1' })).toEqual({ pmoNumber: 'PMO-1' });
    expect(okrIdParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('响应壳与杂项结果', () => {
  it('{ data } 统一壳', () => {
    expect(projectListResponseSchema.parse({ data: [projectRow] }).data).toHaveLength(1);
    expect(projectResponseSchema.parse({ data: projectRow }).data.id).toBe('proj-1');
    expect(deliveryStatusResponseSchema.parse({ data: deliveryRow }).data.policy).toBe('auto-merge');
    expect(deleteOkrResultSchema.parse({ success: true, unlinkedProjects: 0 })).toBeTruthy();
  });

  it('parse-command / publish / sdd 结果形状', () => {
    expect(parsePmoCommandResultSchema.parse({ type: 'auto' })).toEqual({ type: 'auto' });
    expect(parsePmoCommandResultSchema.parse({ type: 'link', pmoNumber: 'PM-001' }).pmoNumber).toBe('PM-001');
    expect(parsePmoCommandResultSchema.safeParse({ type: 'bogus' }).success).toBe(false);
    expect(linkedSddsResultSchema.parse({ sddEntries: [{ slug: 'a', pmoNumber: 'PMO-1', status: '', title: 'a', tags: '' }] })).toBeTruthy();
    // publish 结果复用 channels/workunit 实体（fixture 只需形状合法）
    expect(publishProjectResultSchema.safeParse({ message: {}, workUnit: {}, project: projectRow }).success).toBe(false);
  });

  it('index.ts 出口包含 pmo 域 schema', () => {
    expect(contractIndex.projectSchema).toBe(projectSchema);
    expect(contractIndex.createProjectBodySchema).toBe(createProjectBodySchema);
    expect(contractIndex.deliveryStatusSchema).toBe(deliveryStatusSchema);
    expect(contractIndex.okrSchema).toBe(okrSchema);
  });
});
