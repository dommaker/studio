// AC-7: MCP createWorkUnit tool tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn().mockResolvedValue({
  id: 'wu-1',
  type: 'task',
  scope: 'Test task',
  status: 'unassigned',
});

// Mock prisma (needed by tools.ts module-level side effects)
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { project: { findMany: vi.fn().mockResolvedValue([]) } },
}));

// Mock WorkUnitService
vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    create: mockCreate,
  }; }),
}));

// Import tools (triggers registerAll side effect)
import '../tools.js';
import { toolRegistry } from '../tool-registry.js';

describe('AC-7: createWorkUnit MCP tool', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      id: 'wu-1',
      type: 'task',
      scope: 'Test task',
      status: 'unassigned',
    });
  });

  it('handler returns { workUnitId, type, scope, status }', async () => {
    const tool = toolRegistry.get('createWorkUnit');
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      type: 'task',
      scope: 'Test task',
    });

    expect(result).toEqual({
      workUnitId: 'wu-1',
      type: 'task',
      scope: 'Test task',
      status: 'unassigned',
    });
  });

  it('handler calls WorkUnitService.create with correct input', async () => {
    const tool = toolRegistry.get('createWorkUnit');
    await tool!.handler({
      type: 'analysis',
      scope: 'Analyze X',
      channelId: 'ch-1',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'analysis',
        scope: 'Analyze X',
        channelId: 'ch-1',
        status: 'unassigned',
      })
    );
  });

  it('inputSchema has required type and scope', () => {
    const tool = toolRegistry.get('createWorkUnit');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain('type');
    expect(tool!.inputSchema.required).toContain('scope');
    expect(tool!.inputSchema.properties.type.enum).toEqual(
      expect.arrayContaining(['task', 'analysis', 'monitor', 'discussion'])
    );
  });

  it('tool is registered with medium riskLevel', () => {
    const tool = toolRegistry.get('createWorkUnit');
    expect(tool).toBeDefined();
    expect(tool!.riskLevel).toBe('medium');
  });
});
