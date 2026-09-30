/**
 * harness 域契约测试：八子路由请求边界 + 响应壳 + 宽声明实体。
 * 正本 = apps/api/src/modules/harness/ 八个子路由实测 wire。
 */

import { describe, it, expect } from 'vitest';
import {
  tracesQuerySchema,
  traceRecordBodySchema,
  traceListResultSchema,
  traceAnalysisResultSchema,
  traceAnomaliesResultSchema,
  constraintListResultSchema,
  constraintStatsResultSchema,
  retiredConstraintListResultSchema,
  proposeUpgradeBodySchema,
  rollbackConstraintResultSchema,
  checkConstraintsBodySchema,
  checkConstraintsResultSchema,
  knowledgeQueryBodySchema,
  harnessKnowledgeListQuerySchema,
  harnessKnowledgeSaveBodySchema,
  estimateTokensBodySchema,
  sessionCreateBodySchema,
  sessionEventBodySchema,
  harnessAgentRegisterBodySchema,
  harnessAgentFailBodySchema,
  classifyBodySchema,
  failureRecordBodySchema,
  harnessHealthResultSchema,
  traceListResponseSchema,
  checkConstraintsResponseSchema,
  proposeUpgradeResponseSchema,
  rollbackConstraintResponseSchema,
  harnessKnowledgeListResponseSchema,
  harnessAgentListResponseSchema,
  harnessHealthResponseSchema,
  constraintResultItemSchema,
  harnessConstraintSchema,
} from '../harness.js';
import * as contractIndex from '../index.js';

describe('traces 边界', () => {
  it('POST /traces：constraintId/severity/result 必填收进 zod；bypassed 留词表由 handler 专属 400', () => {
    const body = { constraintId: 'c1', severity: 'error', result: 'pass' };
    expect(traceRecordBodySchema.parse(body)).toEqual(body);
    expect(traceRecordBodySchema.parse({ ...body, result: 'bypassed' }).result).toBe('bypassed');
    expect(() => traceRecordBodySchema.parse({ severity: 'error', result: 'pass' })).toThrow();
    expect(() => traceRecordBodySchema.parse({ ...body, result: 'unknown' })).toThrow();
  });

  it('query 全可选', () => {
    expect(tracesQuerySchema.parse({})).toEqual({});
    expect(tracesQuerySchema.parse({ hours: '12', limit: '10' }).hours).toBe('12');
  });
});

describe('constraints 边界', () => {
  it('propose-upgrade：constraintId 合法字符集收进 zod（原手写 400）', () => {
    expect(proposeUpgradeBodySchema.parse({ constraintId: 'app_my-rule' }).constraintId).toBe('app_my-rule');
    expect(() => proposeUpgradeBodySchema.parse({ constraintId: '../../etc' })).toThrow();
    expect(() => proposeUpgradeBodySchema.parse({})).toThrow();
  });

  it('check-constraints：operation 必填；hasRequirement 保留声明（#641 sanitize 依赖）', () => {
    expect(checkConstraintsBodySchema.parse({ operation: 'goal_creation', hasRequirement: true }).hasRequirement).toBe(true);
    expect(() => checkConstraintsBodySchema.parse({})).toThrow();
  });
});

describe('宽声明实体', () => {
  it('ConstraintResult 项 / 生效约束 passthrough 放行 harness 侧扩展字段', () => {
    const item = constraintResultItemSchema.parse({ id: 'c1', satisfied: true, message: 'm', skipped: true, skipReason: 'r' });
    expect((item as Record<string, unknown>).skipped).toBe(true);
    const c = harnessConstraintSchema.parse({ id: 'c1', kind: 'check', severity: 'error', extra: 1 });
    expect((c as Record<string, unknown>).extra).toBe(1);
    expect(() => harnessConstraintSchema.parse({ kind: 'check', severity: 'error' })).toThrow();
  });
});

describe('knowledge/sessions/agents/diagnostics 边界', () => {
  it('knowledge/query：budget 必填且 positive（对齐原 !budget 拒 0）', () => {
    expect(knowledgeQueryBodySchema.parse({ budget: 100 })).toEqual({ budget: 100 });
    expect(() => knowledgeQueryBodySchema.parse({})).toThrow();
    expect(() => knowledgeQueryBodySchema.parse({ budget: 0 })).toThrow();
  });

  it('knowledge list query 全可选；save：id/title/content 必填收进 zod', () => {
    expect(harnessKnowledgeListQuerySchema.parse({ tags: 'a,b' }).tags).toBe('a,b');
    expect(harnessKnowledgeSaveBodySchema.parse({ id: 'k1', title: 't', content: 'c' })).toEqual({ id: 'k1', title: 't', content: 'c' });
    expect(() => harnessKnowledgeSaveBodySchema.parse({ id: 'k1', title: 't' })).toThrow();
  });

  it('estimate-tokens：text/object 二选一必填（refine）', () => {
    expect(estimateTokensBodySchema.parse({ text: 'hello' })).toEqual({ text: 'hello' });
    expect(estimateTokensBodySchema.parse({ object: { a: 1 } })).toEqual({ object: { a: 1 } });
    expect(() => estimateTokensBodySchema.parse({})).toThrow();
    // 空串 text 回退 object（对齐原 if(text)  falsy 语义）
    expect(estimateTokensBodySchema.parse({ text: '', object: 1 })).toEqual({ text: '', object: 1 });
  });

  it('sessions：id/event 必填', () => {
    expect(sessionCreateBodySchema.parse({ id: 's1' })).toEqual({ id: 's1' });
    expect(() => sessionCreateBodySchema.parse({})).toThrow();
    expect(sessionEventBodySchema.parse({ event: { type: 'x' } })).toEqual({ event: { type: 'x' } });
    expect(() => sessionEventBodySchema.parse({})).toThrow();
  });

  it('agents：id 必填；fail 的 error 可选', () => {
    expect(harnessAgentRegisterBodySchema.parse({ id: 'a1' })).toEqual({ id: 'a1' });
    expect(() => harnessAgentRegisterBodySchema.parse({})).toThrow();
    expect(harnessAgentFailBodySchema.parse({})).toEqual({});
  });

  it('diagnostics：message 必填', () => {
    expect(classifyBodySchema.parse({ message: 'boom' })).toEqual({ message: 'boom' });
    expect(() => classifyBodySchema.parse({})).toThrow();
    expect(failureRecordBodySchema.parse({ message: 'm', type: 't' }).type).toBe('t');
    expect(() => failureRecordBodySchema.parse({})).toThrow();
  });
});

describe('响应壳', () => {
  it('列表壳内层 data 键改名词键：traces/constraints/knowledge/agents', () => {
    const traces = { traces: [{ constraintId: 'c1', severity: 'error', result: 'pass', timestamp: 1 }], total: 1 };
    expect(traceListResultSchema.parse(traces)).toEqual(traces);
    expect(traceListResponseSchema.parse({ data: traces }).data.total).toBe(1);
    expect(constraintListResultSchema.parse({ constraints: [], total: 0 })).toEqual({ constraints: [], total: 0 });
    expect(harnessKnowledgeListResponseSchema.parse({ data: { entries: [], total: 0 } }).data.total).toBe(0);
    expect(harnessAgentListResponseSchema.parse({ data: { agents: [{ id: 'a1' }], total: 1 } }).data.agents).toHaveLength(1);
  });

  it('analysis 五键 / anomalies 三键进壳', () => {
    const a = { summaries: [], anomalies: [], totalSummaries: 0, totalAnomalies: 0, skippedLines: 0 };
    expect(traceAnalysisResultSchema.parse(a)).toEqual(a);
    expect(traceAnomaliesResultSchema.parse({ anomalies: [], total: 0, skippedLines: 2 }).skippedLines).toBe(2);
  });

  it('stats/retired/rollback/propose-upgrade 形状', () => {
    expect(constraintStatsResultSchema.parse({ total: 1, byKind: { check: 1 }, bySeverity: { error: 1 } }).total).toBe(1);
    expect(retiredConstraintListResultSchema.parse({
      retired: [{ id: 'c1', enabled: false, source: 'config', retired: { at: 't' } }], total: 1,
    }).total).toBe(1);
    expect(proposeUpgradeResponseSchema.parse({ data: { proposalId: 'p1', posted: true } }).data.posted).toBe(true);
    expect(rollbackConstraintResponseSchema.parse({ data: { restored: null, rolledBack: true } }).data.restored).toBeNull();
  });

  it('check-constraints：兄弟标注键收进 data 内', () => {
    const result = {
      passed: false,
      errors: [{ id: 'c1', satisfied: false, message: 'm' }],
      warnings: [],
      warningCount: 0,
      strippedEvidenceFlags: ['hasRequirement'],
      violationPartialView: { truncated: true, reason: 'r' },
    };
    expect(checkConstraintsResultSchema.parse(result)).toEqual(result);
    expect(checkConstraintsResponseSchema.parse({ data: result }).data.strippedEvidenceFlags).toEqual(['hasRequirement']);
  });

  it('health → { data: { status, harness, constraintsActive } }', () => {
    const h = { status: 'ok', harness: 'connected', constraintsActive: true };
    expect(harnessHealthResultSchema.parse(h)).toEqual(h);
    expect(harnessHealthResponseSchema.parse({ data: h }).data.status).toBe('ok');
  });
});

describe('index.ts 出口', () => {
  it('harness 域 schema 经 index 导出', () => {
    expect(contractIndex.traceRecordBodySchema).toBeDefined();
    expect(contractIndex.checkConstraintsBodySchema).toBeDefined();
    expect(contractIndex.harnessHealthResponseSchema).toBeDefined();
  });
});
