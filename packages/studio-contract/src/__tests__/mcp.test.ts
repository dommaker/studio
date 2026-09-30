/**
 * mcp 域契约测试：请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/mcp/routes.ts + admin.routes.ts（REST 管理面）。
 */

import { describe, it, expect } from 'vitest';
import {
  mcpToolSchema,
  mcpToolCallBodySchema,
  mcpToolToggleBodySchema,
  mcpPermissionsQuerySchema,
  mcpPermissionSetBodySchema,
  mcpAuditQuerySchema,
  mcpAuditLogSchema,
  mcpToolListResponseSchema,
  mcpToolCallResponseSchema,
  mcpHealthResultSchema,
  mcpAdminToolListResponseSchema,
  mcpAdminStatsResponseSchema,
  mcpRolePermissionsResponseSchema,
  mcpPermissionSetResponseSchema,
  mcpAuditResponseSchema,
} from '../mcp.js';
import * as contractIndex from '../index.js';

describe('请求边界', () => {
  it('POST /tools/:name body passthrough 放行任意 tool 入参，roleId 保留键不剥', () => {
    const body = { roleId: 'executor', path: '/tmp/x', content: 'a', nested: { n: 1 } };
    const parsed = mcpToolCallBodySchema.parse(body);
    expect(parsed.roleId).toBe('executor');
    expect((parsed as Record<string, unknown>).nested).toEqual({ n: 1 });
  });

  it('PATCH /admin/tools/:name：enabled 必须 boolean（原手写 400 退役）', () => {
    expect(mcpToolToggleBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => mcpToolToggleBodySchema.parse({ enabled: 'yes' })).toThrow();
    expect(() => mcpToolToggleBodySchema.parse({})).toThrow();
  });

  it('GET /admin/permissions：roleId 必填', () => {
    expect(mcpPermissionsQuerySchema.parse({ roleId: 'admin' }).roleId).toBe('admin');
    expect(() => mcpPermissionsQuerySchema.parse({})).toThrow();
  });

  it('PUT /admin/permissions：三件套必填', () => {
    const body = { roleId: 'admin', toolName: 'readFile', allowed: true };
    expect(mcpPermissionSetBodySchema.parse(body)).toEqual(body);
    expect(() => mcpPermissionSetBodySchema.parse({ roleId: 'admin', toolName: 'readFile' })).toThrow();
    expect(() => mcpPermissionSetBodySchema.parse({ roleId: '', toolName: 't', allowed: 1 })).toThrow();
  });

  it('GET /admin/audit：success 词表 true/false', () => {
    expect(mcpAuditQuerySchema.parse({ success: 'true' }).success).toBe('true');
    expect(mcpAuditQuerySchema.parse({}).success).toBeUndefined();
    expect(() => mcpAuditQuerySchema.parse({ success: 'yes' })).toThrow();
  });
});

describe('实体', () => {
  it('mcpToolSchema 三键投影', () => {
    const tool = { name: 'readFile', description: 'd', inputSchema: { type: 'object' } };
    expect(mcpToolSchema.parse(tool)).toEqual(tool);
  });

  it('审计行 passthrough 放行历史扩展键', () => {
    const row = {
      id: 'a1', toolName: 't', duration: 5, success: true,
      createdAt: '2026-09-30T00:00:00.000Z', extra: 'x',
    };
    const parsed = mcpAuditLogSchema.parse(row);
    expect((parsed as Record<string, unknown>).extra).toBe('x');
  });

  it('GET /health 三态词表', () => {
    for (const status of ['healthy', 'degraded', 'unhealthy'] as const) {
      expect(mcpHealthResultSchema.parse({ status, tools: [] }).status).toBe(status);
    }
    expect(() => mcpHealthResultSchema.parse({ status: 'ok', tools: [] })).toThrow();
  });
});

describe('响应壳', () => {
  it('GET /tools → { data: { tools, total } }（名词键，避免 data.data 双包）', () => {
    const body = { data: { tools: [{ name: 't', description: 'd', inputSchema: {} }], total: 1 } };
    expect(mcpToolListResponseSchema.parse(body).data.total).toBe(1);
  });

  it('POST /tools/:name → { data: { result, duration } }', () => {
    const body = { data: { result: { ok: 1 }, duration: 12 } };
    expect(mcpToolCallResponseSchema.parse(body).data.duration).toBe(12);
  });

  it('GET /admin/tools → { data: { tools, total } }（stats 可 null）', () => {
    const item = { name: 't', description: 'd', stats: null };
    expect(mcpAdminToolListResponseSchema.parse({ data: { tools: [item], total: 1 } }).data.tools[0].stats).toBeNull();
  });

  it('GET /admin/stats → { data: 五键 }', () => {
    const stats = {
      totalTools: 2, enabledTools: 1, totalCalls: 10, successRate: 90,
      byTool: { t: { totalCalls: 10, successCalls: 9, errorCalls: 1, avgDuration: 3 } },
    };
    expect(mcpAdminStatsResponseSchema.parse({ data: stats }).data.successRate).toBe(90);
  });

  it('permissions / audit → { data } 壳', () => {
    expect(mcpRolePermissionsResponseSchema.parse({
      data: { roleId: 'admin', permissions: [{ toolName: 't', allowed: true }] },
    }).data.permissions).toHaveLength(1);
    expect(mcpPermissionSetResponseSchema.parse({
      data: { roleId: 'admin', toolName: 't', allowed: false },
    }).data.allowed).toBe(false);
    expect(mcpAuditResponseSchema.parse({ data: { logs: [], total: 0 } }).data.total).toBe(0);
  });
});

describe('index.ts 出口', () => {
  it('mcp 域 schema 经 index 导出', () => {
    expect(contractIndex.mcpToolCallBodySchema).toBeDefined();
    expect(contractIndex.mcpAuditResponseSchema).toBeDefined();
  });
});
