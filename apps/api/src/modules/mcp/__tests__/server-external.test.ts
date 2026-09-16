/**
 * P1（#566）：MCPServer 入口侧上下文测试。
 *
 * - tools/list 带 audience='external' → 调 getToolSchemas('external')
 * - tools/call 带 pinnedRoleId → 忽略 params.roleId 自声明（自声明 admin 无效）
 * - 无 ctx → 行为与现状一致（roleId 自声明透传）
 *
 * tools.js 门面被 mock，仅断言调用参数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetToolSchemas, mockExecuteTool } = vi.hoisted(() => ({
  mockGetToolSchemas: vi.fn().mockReturnValue([{ name: 'listProjects', description: '', inputSchema: {} }]),
  mockExecuteTool: vi.fn().mockResolvedValue({ success: true, result: { ok: 1 }, duration: 1 }),
}));

vi.mock('../tools.js', () => ({
  getToolSchemas: mockGetToolSchemas,
  executeTool: mockExecuteTool,
}));

import { MCPServer } from '../server.js';

describe('MCPServer 入口 ctx（#566 D2）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tools/list 带 audience=external 透传过滤参数', async () => {
    const server = new MCPServer();
    const res = await server.handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { audience: 'external', pinnedRoleId: 'external' },
    );
    expect(mockGetToolSchemas).toHaveBeenCalledWith('external');
    expect(res.result?.tools).toHaveLength(1);
  });

  it('tools/list 无 ctx 走默认（全量）', async () => {
    const server = new MCPServer();
    await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mockGetToolSchemas).toHaveBeenCalledWith(undefined);
  });

  it('tools/call 带 pinnedRoleId 时忽略自声明 roleId', async () => {
    const server = new MCPServer();
    await server.handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'createWorkUnit', arguments: {}, roleId: 'admin' } },
      { pinnedRoleId: 'external' },
    );
    expect(mockExecuteTool).toHaveBeenCalledWith('createWorkUnit', {}, 'external');
  });

  it('tools/call 无 ctx 时自声明 roleId 透传（内部入口现状不变）', async () => {
    const server = new MCPServer();
    await server.handleRequest(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listProjects', arguments: {}, roleId: 'executor' } },
    );
    expect(mockExecuteTool).toHaveBeenCalledWith('listProjects', {}, 'executor');
  });
});
