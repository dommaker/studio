/**
 * tools.ts 注册门面测试（T3 拆分新增）。
 *
 * 固化门面对外契约：19 个 tool 的注册顺序、风险级别标注、
 * getToolSchemas 形状，以及 executeTool 的权限/执行路径。
 * permission.service 被 mock；STUDIO_EVENTS_DIR 指向临时目录隔离 trace 写入。
 * #149（2026-08-15）：5 个知识库 tool 随 document-store 退役移除（26 → 21）。
 * 2026-08：checkGuardrail/getSandboxLevel 随 harness 1.2.0 删除
 * InputGuardrail/OutputGuardrail/Sandbox（ADR-0003）移除（21 → 19）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockIsAllowed, mockLogAudit, mockSeed } = vi.hoisted(() => ({
  mockIsAllowed: vi.fn(),
  mockLogAudit: vi.fn().mockResolvedValue(undefined),
  mockSeed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../permission.service.js', () => ({
  mcpPermissionService: { isAllowed: mockIsAllowed, logAudit: mockLogAudit },
  seedDefaultPermissions: mockSeed,
}));

// 隔离 project.service 的重依赖链（channels/workunit）；仅保留 get → null 的最小行为
vi.mock('../../pmo/project.service.js', () => ({
  projectService: { get: vi.fn().mockResolvedValue(null) },
}));

import { getToolSchemas, executeTool } from '../tools.js';
import { toolRegistry } from '../tool-registry.js';

let tmpEvents: string;
let prevEventsDir: string | undefined;

beforeAll(() => {
  tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-facade-'));
  prevEventsDir = process.env.STUDIO_EVENTS_DIR;
  process.env.STUDIO_EVENTS_DIR = tmpEvents;
});

afterAll(() => {
  if (prevEventsDir === undefined) delete process.env.STUDIO_EVENTS_DIR;
  else process.env.STUDIO_EVENTS_DIR = prevEventsDir;
  fs.rmSync(tmpEvents, { recursive: true, force: true });
});

const EXPECTED_ORDER: Array<[string, 'low' | 'medium']> = [
  // PMO 项目 (3)
  ['createProject', 'medium'],
  ['listProjects', 'low'],
  ['getProjectStatus', 'low'],
  // 任务 (5)
  ['getTaskBoard', 'low'],
  ['createTask', 'medium'],
  ['assignTask', 'medium'],
  ['updateTaskStatus', 'medium'],
  ['getTaskStats', 'low'],
  // 经济 (1)
  ['getBalance', 'low'],
  // 规格审查 (4)
  ['createSpec', 'medium'],
  ['approveSpec', 'medium'],
  ['getSpecStatus', 'low'],
  ['listSpecs', 'low'],
  // 安全 (1)
  ['checkConstraint', 'low'],
  // Agent-First 系统 (2)
  ['systemHealth', 'low'],
  ['emitEvent', 'low'],
  // DevOps (1)
  ['publishPackage', 'low'],
  // Skill 按需加载 (1)
  ['loadSkill', 'low'],
  // WorkUnit (1)
  ['createWorkUnit', 'medium'],
];

describe('tools.ts 注册门面', () => {
  it('注册 19 个 tool，顺序与拆分前一致', () => {
    expect(toolRegistry.toolCount).toBe(19);
    expect(getToolSchemas().map(s => s.name)).toEqual(EXPECTED_ORDER.map(([name]) => name));
  });

  it('风险级别标注不变（create/store/extract/approve/assign/update → medium，其余 low）', () => {
    for (const [name, risk] of EXPECTED_ORDER) {
      expect(toolRegistry.get(name)?.riskLevel).toBe(risk);
    }
  });

  it('getToolSchemas 只含 name/description/inputSchema（不含 handler）', () => {
    for (const s of getToolSchemas()) {
      expect(Object.keys(s).sort()).toEqual(['description', 'inputSchema', 'name']);
      expect(typeof s.description).toBe('string');
      expect(s.inputSchema.type).toBe('object');
    }
  });

  it('executeTool 未知 tool → 抛 Unknown or disabled', async () => {
    await expect(executeTool('noSuchTool', {})).rejects.toThrow('Unknown or disabled tool: noSuchTool');
  });

  it('executeTool 权限拒绝 → 抛 Permission denied', async () => {
    mockIsAllowed.mockResolvedValue(false);
    await expect(executeTool('getBalance', { companyId: 'c1' }, 'outsider'))
      .rejects.toThrow('Permission denied: role outsider is not allowed to call tool "getBalance"');
  });

  it('executeTool 成功路径：默认 roleId=executor，返回 { success, result, duration } 并写审计', async () => {
    mockIsAllowed.mockResolvedValue(true);
    mockLogAudit.mockClear();
    const result = await executeTool('checkConstraint', { operation: 'x' });
    expect(mockIsAllowed).toHaveBeenCalledWith('executor', 'checkConstraint');
    expect(result.success).toBe(true);
    expect(typeof result.duration).toBe('number');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'checkConstraint', roleId: 'executor', success: true,
    }));
  });

  it('executeTool handler 抛错时审计 success=false 并继续抛出', async () => {
    mockIsAllowed.mockResolvedValue(true);
    mockLogAudit.mockClear();
    // getProjectStatus 对不存在的 projectId 会抛错（projectService.get mock 返回 null → Project not found）
    await expect(executeTool('getProjectStatus', { projectId: 'definitely-missing' }, 'executor'))
      .rejects.toThrow();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'getProjectStatus', success: false, error: expect.any(String),
    }));
  });

  it('模块加载时种子默认权限（19 个 tool 名）', async () => {
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalled());
    expect(mockSeed).toHaveBeenCalledWith(EXPECTED_ORDER.map(([name]) => name));
  });
});
