/**
 * workunit 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 +
 * 与后端 wire 行为对齐的关键形状（正本 = workunit-crud.ts WorkUnitData + 路由实测）。
 */

import { describe, it, expect } from 'vitest';
import {
  workUnitSchema,
  type WorkUnit,
  listWorkUnitsQuerySchema,
  lastDoneQuerySchema,
  createWorkUnitBodySchema,
  updateWorkUnitBodySchema,
  fromMessageBodySchema,
  claimBodySchema,
  transitionStatusBodySchema,
  reviewConfirmPayloadSchema,
  reviewPassedBodySchema,
  verifyBodySchema,
  planRulingPayloadSchema,
  planDirectionPayloadSchema,
  postMessageBodySchema,
  patchMessageBodySchema,
  verifyResultSchema,
  discussionMessagesResultSchema,
  adoptOpportunityResultSchema,
  workUnitResponseSchema,
  workUnitListResponseSchema,
  lastDoneResponseSchema,
} from '../workunit.js';
import * as contractIndex from '../index.js';

/** 后端 snapshotToData JSON 序列化后的最小合法形状（interface 类型即 parity 被测对象） */
const wuRow: WorkUnit = {
  id: 'wu-1',
  parentId: null,
  type: 'task',
  scope: '实现登录',
  assigneeId: null,
  status: 'unassigned',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  projectPath: null,
  workspaceId: null,
  reqId: null,
  assigneeRoleId: null,
  metadata: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  claimedAt: null,
  completedAt: null,
};

describe('workUnitSchema', () => {
  it('接受后端 wire 形状（含可选项缺失/claimable 列表标记）', () => {
    expect(workUnitSchema.parse(wuRow)).toEqual(wuRow);
    expect(workUnitSchema.parse({ ...wuRow, claimable: true }).claimable).toBe(true);
    const { workspaceId: _w, reqId: _r, assigneeRoleId: _a, ...sparse } = wuRow;
    expect(workUnitSchema.safeParse(sparse).success).toBe(true);
  });

  it('缺必填字段/类型错误 → 拒绝', () => {
    expect(workUnitSchema.safeParse({ ...wuRow, scope: 1 }).success).toBe(false);
    const { id: _id, ...noId } = wuRow;
    expect(workUnitSchema.safeParse(noId).success).toBe(false);
    expect(workUnitSchema.safeParse({ ...wuRow, parentId: undefined }).success).toBe(false);
  });

  // strict:false 仓 z.infer 全字段退化可选 → WorkUnit 是手写 interface；
  // parity 测试兜「interface ↔ schema 漂移」（改一边不改另一边时这里红）
  it('parity：WorkUnit interface fixture 全键 = schema.shape 键且通过校验', () => {
    const full: WorkUnit & Required<Pick<WorkUnit, 'workspaceId' | 'reqId' | 'assigneeRoleId' | 'claimable'>> = {
      ...wuRow,
      claimable: false,
    };
    expect(workUnitSchema.parse(full)).toEqual(full);
    expect(Object.keys(workUnitSchema.shape).sort()).toEqual(Object.keys(full).sort());
  });

  it('parity：interface 必填字段逐一删除 → schema 拒绝（必填集对齐）', () => {
    const OPTIONAL_KEYS = new Set(['workspaceId', 'reqId', 'assigneeRoleId', 'claimable']);
    const requiredKeys = Object.keys(wuRow).filter(k => !OPTIONAL_KEYS.has(k));
    expect(requiredKeys.length).toBeGreaterThan(0);
    for (const key of requiredKeys) {
      const { [key]: _drop, ...rest } = wuRow as Record<string, unknown>;
      expect(workUnitSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
    // interface 可选字段删除 → 仍通过
    for (const key of ['workspaceId', 'reqId', 'assigneeRoleId']) {
      const { [key]: _drop, ...rest } = wuRow as Record<string, unknown>;
      expect(workUnitSchema.safeParse(rest).success, `删除可选 ${key} 应放行`).toBe(true);
    }
  });
});

describe('请求 schema', () => {
  it('list query：全可选宽松透传（attributed=bogus 不 400，由 handler 归一）', () => {
    expect(listWorkUnitsQuerySchema.parse({})).toEqual({});
    expect(listWorkUnitsQuerySchema.parse({ attributed: 'bogus', q: ' x ', page: '2' }))
      .toEqual({ attributed: 'bogus', q: ' x ', page: '2' });
  });

  it('last-done query：assigneeIds 必填非空', () => {
    expect(lastDoneQuerySchema.parse({ assigneeIds: 'a,b' })).toEqual({ assigneeIds: 'a,b' });
    expect(lastDoneQuerySchema.safeParse({}).success).toBe(false);
    expect(lastDoneQuerySchema.safeParse({ assigneeIds: '' }).success).toBe(false);
  });

  it('create body：scope 必填非空；metadata 是对象（前端手抄版的 string 声明是漂移）', () => {
    expect(createWorkUnitBodySchema.parse({ scope: 'x' })).toEqual({ scope: 'x' });
    expect(createWorkUnitBodySchema.safeParse({}).success).toBe(false);
    expect(createWorkUnitBodySchema.safeParse({ scope: '' }).success).toBe(false);
    expect(createWorkUnitBodySchema.safeParse({ scope: 'x', metadata: '{"a":1}' }).success).toBe(false);
    expect(createWorkUnitBodySchema.safeParse({ scope: 'x', metadata: { a: 1 } }).success).toBe(true);
  });

  it('update body：全可选；assigneeId null = 显式释放', () => {
    expect(updateWorkUnitBodySchema.parse({})).toEqual({});
    expect(updateWorkUnitBodySchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
  });

  it('from-message body：messageId 必填', () => {
    expect(fromMessageBodySchema.parse({ messageId: 'm-1' })).toEqual({ messageId: 'm-1' });
    expect(fromMessageBodySchema.safeParse({}).success).toBe(false);
  });

  it('claim body：agentId 可省略（缺省 = 会话用户）；空对象合法', () => {
    expect(claimBodySchema.parse({})).toEqual({});
    expect(claimBodySchema.safeParse({ agentId: '' }).success).toBe(false);
  });

  it('status body：status 必填非空；authorType 为 A2A 自声明身份可附带', () => {
    expect(transitionStatusBodySchema.parse({ status: 'done' })).toEqual({ status: 'done' });
    expect(transitionStatusBodySchema.parse({ status: 'done', authorType: 'agent' }).authorType).toBe('agent');
    expect(transitionStatusBodySchema.safeParse({}).success).toBe(false);
  });

  it('review-passed confirm：四形态 discriminatedUnion；未知 kind 拒绝', () => {
    expect(reviewConfirmPayloadSchema.parse({ kind: 'decision', conclusion: 'x' }).kind).toBe('decision');
    expect(reviewConfirmPayloadSchema.parse({ kind: 'spec', tasks: [{ title: 't' }] }).kind).toBe('spec');
    expect(reviewConfirmPayloadSchema.parse({ kind: 'analysis', fog: ['q'] }).kind).toBe('analysis');
    expect(reviewConfirmPayloadSchema.parse({ kind: 'plan' }).kind).toBe('plan');
    expect(reviewConfirmPayloadSchema.safeParse({ kind: 'task' }).success).toBe(false);
    // 容忍形态：decision 无 conclusion / spec 无 tasks（语义归一在 confirm-payload.ts）
    expect(reviewConfirmPayloadSchema.safeParse({ kind: 'decision' }).success).toBe(true);
    expect(reviewConfirmPayloadSchema.safeParse({ kind: 'spec' }).success).toBe(true);
    expect(reviewPassedBodySchema.parse({ confirm: { kind: 'decision' } })).toEqual({ confirm: { kind: 'decision' } });
  });

  it('verify body：commands 字符串数组（非字符串元素 → 400，旧行为是静默过滤）', () => {
    expect(verifyBodySchema.parse({ commands: ['pnpm test'] })).toEqual({ commands: ['pnpm test'] });
    expect(verifyBodySchema.safeParse({ commands: ['a', 42] }).success).toBe(false);
  });

  it('ruling payload：items 非空；action ∈ accept/reopen', () => {
    expect(planRulingPayloadSchema.parse({ items: [{ question: 'q', action: 'accept', conclusion: 'c' }] }))
      .toEqual({ items: [{ question: 'q', action: 'accept', conclusion: 'c' }] });
    expect(planRulingPayloadSchema.safeParse({ items: [] }).success).toBe(false);
    expect(planRulingPayloadSchema.safeParse({ items: [{ question: 'q', action: 'maybe' }] }).success).toBe(false);
    // accept 缺 conclusion 过形状校验（语义 400 由 plan-ruling PlanRulingError 兜）
    expect(planRulingPayloadSchema.safeParse({ items: [{ question: 'q', action: 'accept' }] }).success).toBe(true);
  });

  it('direction payload：choice 必填非空', () => {
    expect(planDirectionPayloadSchema.parse({ choice: '自研' })).toEqual({ choice: '自研' });
    expect(planDirectionPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('post message body：content trim 后非空', () => {
    expect(postMessageBodySchema.parse({ content: '  hi  ' })).toEqual({ content: 'hi' });
    expect(postMessageBodySchema.safeParse({ content: '   ' }).success).toBe(false);
  });

  it('patch message body：content/meta 全可选（至少其一由 handler 守卫）', () => {
    expect(patchMessageBodySchema.parse({})).toEqual({});
    expect(patchMessageBodySchema.parse({ meta: '{"a":1}' })).toEqual({ meta: '{"a":1}' });
    expect(patchMessageBodySchema.parse({ meta: { a: 1 } })).toEqual({ meta: { a: 1 } });
  });
});

describe('响应 schema', () => {
  it('单实体壳：{ data: WorkUnit }', () => {
    expect(workUnitResponseSchema.parse({ data: wuRow })).toEqual({ data: wuRow });
    expect(workUnitResponseSchema.safeParse(wuRow).success).toBe(false);
  });

  it('列表壳：{ data, pagination }', () => {
    const body = { data: [wuRow], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
    expect(workUnitListResponseSchema.parse(body)).toEqual(body);
  });

  it('last-done 壳：{ data: Record<assigneeId, WorkUnit | null> }', () => {
    expect(lastDoneResponseSchema.parse({ data: { a1: wuRow, a2: null } }))
      .toEqual({ data: { a1: wuRow, a2: null } });
  });

  it('verify 结果：verified/failed/report/reason/hint 形状', () => {
    expect(verifyResultSchema.parse({ verified: true, report: { commands: ['x'] } }).verified).toBe(true);
    expect(verifyResultSchema.parse({ verified: false, failed: [{ command: 'c', tail: 't' }] }).failed).toHaveLength(1);
    expect(verifyResultSchema.parse({ verified: false, reason: 'no-commands', hint: 'h' }).reason).toBe('no-commands');
  });

  it('讨论区列表：{ messages, total, hasMore }（非 page/limit 分页壳）', () => {
    const result = { messages: [], total: 0, hasMore: false };
    expect(discussionMessagesResultSchema.parse(result)).toEqual(result);
    expect(discussionMessagesResultSchema.safeParse({ data: [], total: 0 }).success).toBe(false);
  });

  it('adopt 结果：{ workUnit, opportunities }', () => {
    const result = {
      workUnit: wuRow,
      opportunities: [{ id: 'opp-1', problem: 'p', suggestion: 's', status: 'adopted', wuId: 'wu-2' }],
    };
    expect(adoptOpportunityResultSchema.parse(result)).toEqual(result);
    expect(adoptOpportunityResultSchema.safeParse({
      ...result,
      opportunities: [{ id: 'o', problem: 'p', suggestion: 's', status: 'bogus' }],
    }).success).toBe(false);
  });
});

describe('index 出口', () => {
  it('re-export workunit 域符号', () => {
    expect(contractIndex.workUnitSchema).toBe(workUnitSchema);
    expect(contractIndex.createWorkUnitBodySchema).toBe(createWorkUnitBodySchema);
    expect(contractIndex.reviewConfirmPayloadSchema).toBe(reviewConfirmPayloadSchema);
  });
});
