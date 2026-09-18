/**
 * P1（#566）：exposure 标记测试。
 *
 * - MCPToolRegistry.getSchemas(audience)：external 只出 exposure=external 子集，缺省全量
 * - tools.ts 门面：外放子集恰为方案选定集合，getBalance/checkConstraint 不外放（Q1 决策）
 *
 * external 角色 seed 派生测试在 permission-seed.test.ts（避开门面后台 seed 干扰）。
 */
import { describe, it, expect } from 'vitest';
import { MCPToolRegistry, toolRegistry } from '../tool-registry.js';
import '../tools.js'; // 触发门面注册

describe('MCPToolRegistry.getSchemas audience 过滤', () => {
  it('external 只出 exposure=external，缺省 internal 出全量', () => {
    const reg = new MCPToolRegistry();
    reg.register({ name: 'readA', description: '', inputSchema: {}, handler: async () => null, exposure: 'external' });
    reg.register({ name: 'readB', description: '', inputSchema: {}, handler: async () => null, exposure: 'external' });
    reg.register({ name: 'writeC', description: '', inputSchema: {}, handler: async () => null });

    expect(reg.getSchemas('external').map(s => s.name)).toEqual(['readA', 'readB']);
    expect(reg.getSchemas().map(s => s.name)).toEqual(['readA', 'readB', 'writeC']);
    expect(reg.getSchemas('internal').map(s => s.name)).toEqual(['readA', 'readB', 'writeC']);
  });
});

describe('tools.ts 门面 exposure 标记', () => {
  const EXPECTED_EXTERNAL = [
    'listProjects', 'getProjectStatus',
    'getTaskBoard', 'getTaskStats',
    'getSpecStatus', 'listSpecs',
    'systemHealth', 'loadSkill',
    // P2 新增读 tool
    'getWorkUnit', 'listWorkUnits',
    'getChannelMessages',
    'getRequirement', 'listRequirements',
  ];

  it('外放子集恰为方案选定集合，getBalance/checkConstraint 不外放', () => {
    const external = toolRegistry.getSchemas('external').map(s => s.name).sort();
    expect(external).toEqual([...EXPECTED_EXTERNAL].sort());
    expect(toolRegistry.get('getBalance')?.exposure).toBeUndefined();
    expect(toolRegistry.get('checkConstraint')?.exposure).toBeUndefined();
  });

  it('外放子集不含任何写 tool（create/assign/update/approve/publish/emit 前缀）', () => {
    for (const s of toolRegistry.getSchemas('external')) {
      expect(s.name).not.toMatch(/^(create|assign|update|approve|publish|emit|delete)/);
    }
  });
});
