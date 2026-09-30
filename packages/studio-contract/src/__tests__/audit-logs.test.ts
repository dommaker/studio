/**
 * audit-logs 域契约测试：行/stats parity + 查询边界 + 响应壳。
 * 正本 = apps/api/src/modules/audit-logs/routes.ts +
 * packages/studio-audit audit-service.ts + proposal-source.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  auditLogRowSchema,
  type AuditLog,
  auditLogStatsSchema,
  type AuditLogStats,
  auditLogListQuerySchema,
  auditLogStatsQuerySchema,
  auditLogExportQuerySchema,
  auditLogCreateBodySchema,
  auditLogListResponseSchema,
  auditLogStatsResponseSchema,
  auditLogGetResponseSchema,
} from '../audit-logs.js';
import * as contractIndex from '../index.js';

/** 前端归一后消费形状 fixture（details/changes 对象形态——union 双形态之一） */
const normalizedRow: AuditLog = {
  id: 'a1',
  action: 'create',
  resource: 'workunit',
  status: 'success',
  createdAt: '2026-09-20T00:00:00.000Z',
  details: { via: 'mention' },
  changes: { after: { x: 1 } },
  actorType: 'human',
};

const stats: AuditLogStats = {
  totalLogs: 100,
  successCount: 80,
  failureCount: 20,
  topActions: [{ action: 'create', count: 10 }],
  topResources: [{ resource: 'workunit', count: 5 }],
  topUsers: [{ userId: 'u1', count: 3 }],
  dailyStats: [{ date: '2026-09-20', count: 7 }],
};

describe('auditLogRowSchema', () => {
  it('parity：归一后 fixture 通过校验（details/changes 对象形态）', () => {
    expect(auditLogRowSchema.parse(normalizedRow)).toEqual(normalizedRow);
  });

  it('wire 原形态：details/changes 为 JSON 串或 null 合法', () => {
    const wireRow = {
      id: 'a2', action: 'propose', resource: 'distill', status: 'executed',
      createdAt: '2026-09-20T01:00:00.000Z', details: '{"author":"KK"}', changes: null,
    };
    expect(auditLogRowSchema.parse(wireRow)).toEqual(wireRow);
  });

  it('历史行稀疏：可选键缺省合法；扩展键 passthrough 放行；必填键缺失抛错', () => {
    const sparse = { id: 'a3', action: 'login', resource: 'session', status: 'success', createdAt: 't' };
    expect(auditLogRowSchema.parse(sparse)).toEqual(sparse);
    const extended = auditLogRowSchema.parse({ ...sparse, futureField: 1 });
    expect((extended as Record<string, unknown>).futureField).toBe(1);
    expect(() => auditLogRowSchema.parse({ ...sparse, action: undefined })).toThrow();
    expect(() => auditLogRowSchema.parse({ ...sparse, createdAt: undefined })).toThrow();
  });

  it('actorType 词表（human/agent）', () => {
    const base = { id: 'a4', action: 'x', resource: 'y', status: 'success', createdAt: 't' };
    expect(auditLogRowSchema.parse({ ...base, actorType: 'agent' }).actorType).toBe('agent');
    expect(() => auditLogRowSchema.parse({ ...base, actorType: 'robot' })).toThrow();
  });
});

describe('auditLogStatsSchema parity', () => {
  it('fixture 通过校验；缺必填段抛错', () => {
    expect(auditLogStatsSchema.parse(stats)).toEqual(stats);
    expect(() => auditLogStatsSchema.parse({ ...stats, totalLogs: undefined })).toThrow();
    expect(() => auditLogStatsSchema.parse({ ...stats, dailyStats: undefined })).toThrow();
  });
});

describe('查询/创建边界', () => {
  it('list query：全可选；actorType/source 收紧词表（原任意串透传）', () => {
    expect(auditLogListQuerySchema.parse({})).toEqual({});
    expect(auditLogListQuerySchema.parse({ source: 'all', actorType: 'agent', page: '2' }).source).toBe('all');
    expect(() => auditLogListQuerySchema.parse({ source: 'everything' })).toThrow();
    expect(() => auditLogListQuerySchema.parse({ actorType: 'robot' })).toThrow();
  });

  it('stats/export query：export 不声明分页参数（剥离）', () => {
    expect(auditLogStatsQuerySchema.parse({ userId: 'u1' })).toEqual({ userId: 'u1' });
    const parsed = auditLogExportQuerySchema.parse({ action: 'login', page: '9' } as Record<string, unknown>);
    expect((parsed as Record<string, unknown>).page).toBeUndefined();
    expect(parsed.action).toBe('login');
  });

  it('create body：action/resource 必填收紧（原透传落废行）；status/actorType 词表；passthrough 放行', () => {
    expect(auditLogCreateBodySchema.parse({ action: 'create', resource: 'user' }))
      .toEqual({ action: 'create', resource: 'user' });
    expect(() => auditLogCreateBodySchema.parse({ resource: 'user' })).toThrow();
    expect(() => auditLogCreateBodySchema.parse({ action: 'create', resource: 'user', status: 'ok' })).toThrow();
    const withExtra = auditLogCreateBodySchema.parse({ action: 'a', resource: 'r', customKey: true });
    expect((withExtra as Record<string, unknown>).customKey).toBe(true);
  });
});

describe('响应壳', () => {
  it('GET / → { data: row[], pagination }（形状与 formatPaginatedResponse 等价）', () => {
    const body = {
      data: [normalizedRow],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    expect(auditLogListResponseSchema.parse(body).pagination.total).toBe(1);
  });

  it('GET /stats 与 /:id → { data } 壳', () => {
    expect(auditLogStatsResponseSchema.parse({ data: stats }).data.totalLogs).toBe(100);
    expect(auditLogGetResponseSchema.parse({ data: normalizedRow }).data.id).toBe('a1');
  });
});

describe('index.ts 出口', () => {
  it('audit-logs 域 schema 经 index 导出', () => {
    expect(contractIndex.auditLogRowSchema).toBeDefined();
    expect(contractIndex.auditLogListQuerySchema).toBeDefined();
    expect(contractIndex.auditLogCreateBodySchema).toBeDefined();
  });
});
