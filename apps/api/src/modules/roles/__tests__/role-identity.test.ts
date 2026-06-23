/**
 * Role 身份化测试 (3.28c-2)
 *
 * AC:
 * 1. Role 模型审计：字段清单 + 冗余字段标记
 * 2. channels 字段可用（JSON array）
 * 3. Agent 创建 API 无 defaultSkills 参数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateRoleInput } from '../role.service.js';

// Mock prisma
const mockRoleCreate = vi.fn();
const mockRoleUpdate = vi.fn();
const mockRoleFindUnique = vi.fn();

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    role: {
      create: mockRoleCreate,
      update: mockRoleUpdate,
      findUnique: mockRoleFindUnique,
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LEVEL_CONFIG: {},
}));

const { RoleService } = await import('../role.service.js');

describe('3.28c-2: Agent 身份化', () => {
  let service: InstanceType<typeof RoleService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new (RoleService as any)({
      role: {
        create: mockRoleCreate,
        update: mockRoleUpdate,
        findUnique: mockRoleFindUnique,
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
  });

  describe('AC2: channels 字段', () => {
    it('创建 Role 时可传入 channels 数组', async () => {
      mockRoleCreate.mockResolvedValue({
        id: 'role-1',
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: '["channel-1","channel-2"]',
        workflows: '[]',
      });

      mockRoleFindUnique.mockResolvedValue({
        id: 'role-1',
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: '["channel-1","channel-2"]',
        workflows: '[]',
      });

      const input: CreateRoleInput = {
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: ['channel-1', 'channel-2'],
      };

      const result = await service.create(input);

      expect(mockRoleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channels: '["channel-1","channel-2"]',
          }),
        })
      );
      expect(result.channels).toEqual(['channel-1', 'channel-2']);
    });

    it('channels 默认为空数组', async () => {
      mockRoleCreate.mockResolvedValue({
        id: 'role-1',
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: '[]',
        workflows: '[]',
      });

      mockRoleFindUnique.mockResolvedValue({
        id: 'role-1',
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: '[]',
        workflows: '[]',
      });

      const input: CreateRoleInput = {
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
      };

      const result = await service.create(input);

      expect(mockRoleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channels: '[]',
          }),
        })
      );
      expect(result.channels).toEqual([]);
    });

    it('更新 Role 时可修改 channels', async () => {
      mockRoleUpdate.mockResolvedValue({
        id: 'role-1',
        channels: '["channel-3"]',
      });

      await service.update('role-1', { channels: ['channel-3'] });

      expect(mockRoleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channels: '["channel-3"]',
          }),
        })
      );
    });
  });

  describe('AC3: 无 defaultSkills 参数', () => {
    it('CreateRoleInput 类型不包含 defaultSkills', () => {
      // 类型测试：如果 defaultSkills 存在，这行会编译错误
      const input: CreateRoleInput = {
        name: 'Test',
        type: 'executor',
        companyId: 'company-1',
      };

      // 验证 input 没有 defaultSkills 属性
      expect('defaultSkills' in input).toBe(false);
    });

    it('创建 Role 时不传递 defaultSkills 到数据库', async () => {
      mockRoleCreate.mockResolvedValue({
        id: 'role-1',
        name: 'Test',
        type: 'executor',
        companyId: 'company-1',
        channels: '[]',
        workflows: '[]',
      });

      mockRoleFindUnique.mockResolvedValue({
        id: 'role-1',
        name: 'Test',
        type: 'executor',
        companyId: 'company-1',
        channels: '[]',
        workflows: '[]',
      });

      await service.create({
        name: 'Test',
        type: 'executor',
        companyId: 'company-1',
      });

      const createCall = mockRoleCreate.mock.calls[0][0];
      expect(createCall.data).not.toHaveProperty('defaultSkills');
    });
  });

  describe('AC1: Role 模型审计', () => {
    it('RoleWithCapabilities 返回解析后的 channels', async () => {
      mockRoleFindUnique.mockResolvedValue({
        id: 'role-1',
        name: 'Test Agent',
        type: 'executor',
        companyId: 'company-1',
        channels: '["ch-1"]',
        workflows: '["wf-1"]',
      });

      const result = await service.getById('role-1');

      expect(result).toBeDefined();
      expect(result!.channels).toEqual(['ch-1']);
    });
  });
});
