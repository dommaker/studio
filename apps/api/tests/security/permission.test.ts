/**
 * 权限测试 - Permission Tests
 * SEC-002: 删除操作权限矩阵
 * SEC-003: 权限矩阵默认拒绝
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hasPermission, PERMISSION_MATRIX } from '../../src/config/permission-matrix.js';

const prisma = new PrismaClient();

describe('SEC-002/003: 权限矩阵', () => {
  describe('SEC-003: 默认拒绝未定义操作', () => {
    it('未定义的操作应该返回 false', () => {
      // 这是一个未在 PERMISSION_MATRIX 中定义的操作
      const result = hasPermission('Admin', 'undefined_operation_xyz');
      expect(result).toBe(false);
    });

    it('任意角色对未定义操作都返回 false', () => {
      expect(hasPermission('CEO', 'random_action')).toBe(false);
      expect(hasPermission('TechLead', 'another_action')).toBe(false);
      expect(hasPermission('Developer', 'third_action')).toBe(false);
    });
  });

  describe('SEC-002: 已定义操作的权限检查', () => {
    it('create_meeting 权限检查', () => {
      expect(hasPermission('CEO', 'create_meeting')).toBe(true);
      expect(hasPermission('Tech Lead', 'create_meeting')).toBe(true);
      expect(hasPermission('PM', 'create_meeting')).toBe(true);
      expect(hasPermission('Developer', 'create_meeting')).toBe(false);
    });

    it('end_meeting 权限检查', () => {
      expect(hasPermission('CEO', 'end_meeting')).toBe(true);
      expect(hasPermission('Tech Lead', 'end_meeting')).toBe(true);
      expect(hasPermission('PM', 'end_meeting')).toBe(false);
    });

    it('view_minutes 权限检查', () => {
      expect(hasPermission('Developer', 'view_minutes')).toBe(true);
      expect(hasPermission('QA', 'view_minutes')).toBe(true);
      expect(hasPermission('CEO', 'view_minutes')).toBe(true);
    });

    it('view_sensitive_minutes 权限检查', () => {
      expect(hasPermission('CEO', 'view_sensitive_minutes')).toBe(true);
      expect(hasPermission('Tech Lead', 'view_sensitive_minutes')).toBe(true);
      expect(hasPermission('PM', 'view_sensitive_minutes')).toBe(false);
      expect(hasPermission('Developer', 'view_sensitive_minutes')).toBe(false);
    });
  });

  describe('角色名格式兼容', () => {
    it('应该兼容不同格式的角色名', () => {
      // 带空格、带连字符的格式
      expect(hasPermission('TechLead', 'create_meeting')).toBe(true);
      expect(hasPermission('Tech-Lead', 'create_meeting')).toBe(true);
      expect(hasPermission('Tech_Lead', 'create_meeting')).toBe(true);
      expect(hasPermission('Tech Lead', 'create_meeting')).toBe(true);
    });
  });
});

describe('PERMISSION_MATRIX 定义', () => {
  it('应该包含必要的操作定义', () => {
    expect(PERMISSION_MATRIX).toHaveProperty('create_meeting');
    expect(PERMISSION_MATRIX).toHaveProperty('end_meeting');
    expect(PERMISSION_MATRIX).toHaveProperty('view_minutes');
    expect(PERMISSION_MATRIX).toHaveProperty('view_sensitive_minutes');
  });

  it('每个操作应该定义允许的角色列表', () => {
    Object.entries(PERMISSION_MATRIX).forEach(([action, roles]) => {
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    });
  });
});
