// @ts-nocheck
/**
 * AuditService 测试
 *
 * 覆盖 7 个核心方法：
 * - log
 * - logBatch
 * - query
 * - getById
 * - getStats
 * - cleanup
 * - export
 *
 * 改用 FileStore 后验证实际文件 IO：
 * 1. mock os.homedir() 重定向到临时目录
 * 2. 用 fs.writeFileSync 预填充 audit.jsonl
 * 3. 验证 log() / logBatch() 写入文件内容
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { AuditService, AuditActions, AuditResources } from '../audit-service';

// vi.hoisted 在模块导入前执行，确保 tempDir 在 audit-service.ts 评估前就存在
const tempDir = vi.hoisted(() => {
  const _fs = require('node:fs') as typeof import('node:fs');
  return _fs.mkdtempSync('/tmp/audit-test-');
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tempDir,
  };
});

const jsonlDir = path.join(tempDir, '.studio', 'logs');
const jsonlPath = path.join(jsonlDir, 'audit.jsonl');

/** 写预填充行到 audit.jsonl */
function writeFixture(rows: Record<string, unknown>[]): void {
  fs.mkdirSync(jsonlDir, { recursive: true });
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, content, 'utf-8');
}

/** 解析 audit.jsonl 所有行 */
function readLines(): Record<string, unknown>[] {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    return content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('AuditService', () => {
  let service: AuditService;
  let fileStore: FileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // 清理可能存在的旧数据
    try { fs.rmSync(jsonlDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fileStore = new FileStore();
    service = new AuditService(fileStore);
  });

  // ============================================
  // AC-001: AuditActions 常量
  // ============================================
  describe('AuditActions', () => {
    it('包含常用操作类型', () => {
      expect(AuditActions.CREATE).toBe('create');
      expect(AuditActions.UPDATE).toBe('update');
      expect(AuditActions.DELETE).toBe('delete');
      expect(AuditActions.EXECUTE).toBe('execute');
    });
  });

  // ============================================
  // AC-002: AuditResources 常量
  // ============================================
  describe('AuditResources', () => {
    it('包含常用资源类型', () => {
      expect(AuditResources.ROLE).toBe('role');
      expect(AuditResources.COMPANY).toBe('company');
    });
  });

  // ============================================
  // AC-003: log
  // ============================================
  describe('log', () => {
    it('正常记录审计日志', async () => {
      await service.log({
        action: 'create',
        resource: 'task',
        userId: 'user-1',
      });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].action).toBe('create');
      expect(lines[0].resource).toBe('task');
      expect(lines[0].userId).toBe('user-1');
      expect(lines[0].id).toContain('audit_');
      expect(lines[0].createdAt).toBeDefined();
    });

    it('记录失败操作', async () => {
      await service.log({
        action: 'create',
        resource: 'task',
        status: 'failure',
        errorMessage: 'Something went wrong',
      });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].status).toBe('failure');
      expect(lines[0].errorMessage).toBe('Something went wrong');
    });

    it('序列化 details 和 changes', async () => {
      await service.log({
        action: 'update',
        resource: 'role',
        changes: {
          before: { level: 1 },
          after: { level: 2 },
          fields: ['level'],
        },
        details: { reason: 'promotion' },
      });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      // changes 字段已序列化为 JSON 字符串
      expect(typeof lines[0].changes).toBe('string');
      expect(JSON.parse(lines[0].changes as string)).toEqual({
        before: { level: 1 },
        after: { level: 2 },
        fields: ['level'],
      });
      expect(typeof lines[0].details).toBe('string');
      expect(JSON.parse(lines[0].details as string)).toEqual({ reason: 'promotion' });
    });
  });

  // ============================================
  // AC-004: logBatch
  // ============================================
  describe('logBatch', () => {
    it('批量记录日志', async () => {
      const count = await service.logBatch([
        { action: 'create', resource: 'capability' },
        { action: 'update', resource: 'role' },
        { action: 'delete', resource: 'task' },
      ]);

      expect(count).toBe(3);
      const lines = readLines();
      expect(lines).toHaveLength(3);
      expect(lines.map(l => l.action)).toEqual(['create', 'update', 'delete']);
    });
  });

  // ============================================
  // AC-005: query
  // ============================================
  describe('query', () => {
    it('全部查询返回所有行', async () => {
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a2', action: 'update', resource: 'role', userId: 'u2', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a3', action: 'delete', resource: 'company', userId: 'u1', status: 'failure', createdAt: new Date().toISOString() },
      ]);

      const result = await service.query({});

      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('按 userId 过滤', async () => {
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a2', action: 'update', resource: 'role', userId: 'u2', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a3', action: 'delete', resource: 'company', userId: 'u1', status: 'failure', createdAt: new Date().toISOString() },
      ]);

      const result = await service.query({ userId: 'u1' });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      result.data.forEach(r => expect(r.userId).toBe('u1'));
    });

    it('按时间范围过滤', async () => {
      const now = Date.now();
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: new Date(now - 86400000).toISOString() },  // 1 day ago
        { id: 'a2', action: 'update', resource: 'role', userId: 'u2', status: 'success', createdAt: new Date(now - 3600000).toISOString() },   // 1 hour ago
        { id: 'a3', action: 'delete', resource: 'company', userId: 'u1', status: 'failure', createdAt: new Date(now - 7 * 86400000).toISOString() },  // 7 days ago
      ]);

      const startTime = new Date(now - 2 * 86400000);
      const endTime = new Date(now);
      const result = await service.query({ startTime, endTime });

      expect(result.data).toHaveLength(2);
    });

    it('分页查询', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        action: 'create',
        resource: 'task',
        userId: 'u1',
        status: 'success',
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
      }));
      writeFixture(entries);

      const result = await service.query({ page: 2, limit: 3 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(3);
      // 降序排列，第 2 页取索引 3~5（0-based）
      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(10);
    });
  });

  // ============================================
  // AC-006: getById
  // ============================================
  describe('getById', () => {
    it('根据 ID 获取条目', async () => {
      writeFixture([
        { id: 'target-id', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: new Date().toISOString() },
        { id: 'other-id', action: 'update', resource: 'role', userId: 'u2', status: 'success', createdAt: new Date().toISOString() },
      ]);

      const result = await service.getById('target-id');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('target-id');
      expect(result!.action).toBe('create');
    });

    it('ID 不存在返回 null', async () => {
      writeFixture([
        { id: 'some-id', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: new Date().toISOString() },
      ]);

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ============================================
  // AC-007: getStats
  // ============================================
  describe('getStats', () => {
    it('计算总数 / 成功数 / 失败数', async () => {
      const today = new Date().toISOString();
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: today },
        { id: 'a2', action: 'update', resource: 'role', userId: 'u1', status: 'success', createdAt: today },
        { id: 'a3', action: 'delete', resource: 'task', userId: 'u1', status: 'failure', createdAt: today },
        { id: 'a4', action: 'create', resource: 'company', userId: 'u2', status: 'failure', createdAt: today },
        { id: 'a5', action: 'execute', resource: 'tool', userId: 'u1', status: 'success', createdAt: today },
      ]);

      const stats = await service.getStats();

      expect(stats.totalLogs).toBe(5);
      expect(stats.successCount).toBe(3);
      expect(stats.failureCount).toBe(2);
    });

    it('topActions / topResources / topUsers 正确聚合', async () => {
      const today = new Date().toISOString();
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: today },
        { id: 'a2', action: 'create', resource: 'role', userId: 'u2', status: 'success', createdAt: today },
        { id: 'a3', action: 'create', resource: 'task', userId: 'u1', status: 'success', createdAt: today },
        { id: 'a4', action: 'update', resource: 'role', userId: 'u2', status: 'success', createdAt: today },
        { id: 'a5', action: 'delete', resource: 'company', userId: 'u3', status: 'success', createdAt: today },
      ]);

      const stats = await service.getStats();

      expect(stats.topActions[0]).toEqual({ action: 'create', count: 3 });
      expect(stats.topResources[0]).toEqual({ resource: 'task', count: 2 });
      expect(stats.topUsers[0]).toEqual({ userId: 'u1', count: 2 });
    });
  });

  // ============================================
  // AC-008: cleanup
  // ============================================
  describe('cleanup', () => {
    it('删除超过保留天数的条目', async () => {
      const now = Date.now();
      writeFixture([
        { id: 'old-1', action: 'create', resource: 'task', status: 'success', createdAt: new Date(now - 60 * 86400000).toISOString() },
        { id: 'old-2', action: 'update', resource: 'role', status: 'success', createdAt: new Date(now - 50 * 86400000).toISOString() },
        { id: 'recent', action: 'delete', resource: 'company', status: 'success', createdAt: new Date(now - 5 * 86400000).toISOString() },
      ]);

      const deletedCount = await service.cleanup(30);

      expect(deletedCount).toBe(2);

      const remaining = readLines();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('recent');
    });

    it('自定义保留天数', async () => {
      const now = Date.now();
      writeFixture([
        { id: 'old', action: 'create', resource: 'task', status: 'success', createdAt: new Date(now - 10 * 86400000).toISOString() },
        { id: 'new', action: 'update', resource: 'role', status: 'success', createdAt: new Date(now - 1 * 86400000).toISOString() },
      ]);

      const deletedCount = await service.cleanup(7);

      expect(deletedCount).toBe(1);
      const remaining = readLines();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('new');
    });
  });

  // ============================================
  // AC-009: export
  // ============================================
  describe('export', () => {
    it('导出过滤后的数据', async () => {
      writeFixture([
        { id: 'a1', action: 'create', resource: 'task', companyId: 'c1', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a2', action: 'update', resource: 'role', companyId: 'c2', status: 'success', createdAt: new Date().toISOString() },
        { id: 'a3', action: 'delete', resource: 'company', companyId: 'c1', status: 'failure', createdAt: new Date().toISOString() },
      ]);

      const result = await service.export({ companyId: 'c1' });

      expect(result).toHaveLength(2);
      result.forEach(r => expect(r.companyId).toBe('c1'));
    });
  });

  // ============================================
  // 清理临时目录
  // ============================================
  afterAll(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
