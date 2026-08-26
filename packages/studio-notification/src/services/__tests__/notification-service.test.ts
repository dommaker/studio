// @ts-nocheck
/**
 * NotificationService 测试
 *
 * 使用 FileStore + 临时目录替代 Prisma mock。
 * 覆盖 5 个核心方法：
 * - create
 * - getUserNotifications
 * - markAsRead
 * - markAllAsRead
 * - getUnreadCount
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '../notification-service';

// vi.hoisted runs before vi.mock factory evaluation, ensuring tmpDir
// is initialized before the module-level NOTIFICATIONS_JSONL constant.
const { tmpDir, SETUP_STUDIO_HOME } = vi.hoisted(() => {
  const _fs = require('node:fs');
  const _path = require('node:path');
  const _os = require('node:os');
  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'notif-test-'));
  // #219：setup-isolated-data.setup.ts 把 STUDIO_HOME 钉到隔离根，
  // studioDir() 优先读 STUDIO_HOME，homedir mock 被旁路。
  // notification-service.ts 在 import 期冻结 NOTIFICATIONS_JSONL（studioPath 模块级常量），
  // 因此必须在模块 import 前（本 hoisted 块内）把 STUDIO_HOME 指到本测试的临时数据根。
  // 注意 STUDIO_HOME 指向 .studio 根本身，不是 home 目录。
  const SETUP_STUDIO_HOME = process.env.STUDIO_HOME; // setup 钉的原始值，afterAll 恢复
  process.env.STUDIO_HOME = _path.join(tmpDir, '.studio');
  return { tmpDir, SETUP_STUDIO_HOME };
});

// Redirect os.homedir() to temp dir so NOTIFICATIONS_JSONL resolves
// under tmpDir regardless of the actual home directory.
// Uses importOriginal to preserve all other os functions (platform, EOL, etc.)
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => tmpDir };
});

const jsonlPath = path.join(tmpDir, '.studio', 'logs', 'notifications.jsonl');

describe('NotificationService', () => {
  let service: NotificationService;
  let fileStore: FileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure the directory for notifications.jsonl exists.
    // afterEach removes the whole tmpDir, so each test must recreate it.
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fileStore = new FileStore();
    service = new NotificationService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    // 恢复 setup 文件钉的 STUDIO_HOME，避免污染同 worker 进程后续测试文件
    if (SETUP_STUDIO_HOME === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = SETUP_STUDIO_HOME;
  });

  // ============================================
  // AC-001: create
  // ============================================
  describe('create', () => {
    it('正常创建通知并写入 JSONL', async () => {
      const result = await service.create({
        userId: 'user-1',
        type: 'review_request',
        title: 'Test',
        content: 'Test content',
      });

      // 验证返回对象
      expect(result.id).toContain('notif');
      expect(result.userId).toBe('user-1');
      expect(result.type).toBe('review_request');
      expect(result.title).toBe('Test');
      expect(result.content).toBe('Test content');
      expect(result.createdAt).toBeDefined();

      // 验证文件写入
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.id).toBe(result.id);
      expect(parsed.userId).toBe('user-1');
      expect(parsed.type).toBe('review_request');
    });

    it('创建带链接的通知', async () => {
      const result = await service.create({
        userId: 'user-1',
        type: 'system',
        title: 'Link test',
        content: 'Click link',
        link: 'https://example.com',
      });

      expect(result.link).toBe('https://example.com');

      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.link).toBe('https://example.com');
    });
  });

  // ============================================
  // AC-002: getUserNotifications
  // ============================================
  describe('getUserNotifications', () => {
    it('获取用户通知列表（按 createdAt 降序）', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n2', userId: 'user-1', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');

      expect(result.length).toBe(2);
      expect(result[0].id).toBe('n2');
      expect(result[1].id).toBe('n1');
    });

    it('只返回该用户的通知（不混入其他用户）', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n2', userId: 'user-2', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('n1');
    });

    it('tombstone 被正确解析为已读状态（read + readAt）', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T01:00:00.000Z' },
        { id: 'n2', userId: 'user-1', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');

      expect(result.length).toBe(2);

      const n1 = result.find(r => r.id === 'n1');
      expect(n1!.read).toBe(true);
      expect(n1!.readAt).toBeInstanceOf(Date);
      expect(n1!.readAt!.toISOString()).toBe('2026-01-01T01:00:00.000Z');

      const n2 = result.find(r => r.id === 'n2');
      expect(n2!.read).toBe(false);
      expect(n2!.readAt).toBeNull();
    });

    it('unreadOnly 过滤已读通知', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T01:00:00.000Z' },
        { id: 'n2', userId: 'user-1', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1', { unreadOnly: true });

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('n2');
      expect(result[0].read).toBe(false);
    });

    it('限制返回数量', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n2', userId: 'user-1', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'n3', userId: 'user-1', type: 'system', title: 'N3', content: 'C3', createdAt: '2026-01-03T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1', { limit: 2 });

      expect(result.length).toBe(2);
    });

    it('tombstone 覆盖后通知仍返回但标记已读（append-only 模式，original 行保留）', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'review_request', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T01:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');

      // original 行未标记 deleted, 仍会被纳入结果, 但 read=true
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('n1');
      expect(result[0].read).toBe(true);
      expect(result[0].readAt!.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    });

    // #360 特征测试：钉住边界语义，fold 收敛（3 份 -> 1 份）与共享 fold 接线前后行为不变
    it('多次追加 tombstone 时 readAt 取首个墓碑（重复 markAllAsRead 场景）', async () => {
      const rows = [
        { id: 'n1', userId: 'user-1', type: 'system', title: 'N1', content: 'C1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T01:00:00.000Z' },
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T05:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');

      expect(result.length).toBe(1);
      expect(result[0].read).toBe(true);
      // 首个 tombstone = 用户实际首次已读时刻
      expect(result[0].readAt!.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    });

    it('孤儿 tombstone（无数据行）的通知不可见', async () => {
      const rows = [
        { id: 'n1', deleted: true, deletedAt: '2026-01-01T01:00:00.000Z' },
        { id: 'n2', userId: 'user-1', type: 'system', title: 'N2', content: 'C2', createdAt: '2026-01-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

      const result = await service.getUserNotifications('user-1');
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('n2');
    });
  });

  // ============================================
  // AC-003: markAsRead
  // ============================================
  describe('markAsRead', () => {
    it('追加 tombstone 行到 JSONL', async () => {
      const notif = await service.create({
        userId: 'user-1',
        type: 'review_request',
        title: 'Test',
        content: 'Content',
      });

      await service.markAsRead(notif.id, 'user-1');

      // 验证 tombstone 追加到文件
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(2);
      const tombstone = JSON.parse(lines[1]);
      expect(tombstone.id).toBe(notif.id);
      expect(tombstone.deleted).toBe(true);
      expect(tombstone.deletedAt).toBeDefined();
    });

    it('标记后 getUserNotifications 返回已读状态', async () => {
      const notif = await service.create({
        userId: 'user-1',
        type: 'review_request',
        title: 'Test',
        content: 'Content',
      });

      expect((await service.getUserNotifications('user-1'))[0].read).toBe(false);

      await service.markAsRead(notif.id, 'user-1');

      const result = await service.getUserNotifications('user-1');
      expect(result.length).toBe(1);
      expect(result[0].read).toBe(true);
      expect(result[0].readAt).toBeInstanceOf(Date);
    });
  });

  // ============================================
  // AC-004: markAllAsRead
  // ============================================
  describe('markAllAsRead', () => {
    it('为所有未读通知追加 tombstone', async () => {
      await service.create({ userId: 'user-1', type: 'system', title: 'N1', content: 'C1' });
      await service.create({ userId: 'user-1', type: 'system', title: 'N2', content: 'C2' });

      await service.markAllAsRead('user-1');

      const notifs = await service.getUserNotifications('user-1');
      expect(notifs.length).toBe(2);
      expect(notifs[0].read).toBe(true);
      expect(notifs[1].read).toBe(true);
    });

    it('不影响其他用户的通知', async () => {
      await service.create({ userId: 'user-1', type: 'system', title: 'N1', content: 'C1' });
      await service.create({ userId: 'user-2', type: 'system', title: 'N2', content: 'C2' });

      await service.markAllAsRead('user-1');

      const notifs1 = await service.getUserNotifications('user-1');
      expect(notifs1[0].read).toBe(true);

      const notifs2 = await service.getUserNotifications('user-2');
      expect(notifs2[0].read).toBe(false);
    });

    it('空用户不产生任何写入', async () => {
      await service.markAllAsRead('non-existent-user');

      // 文件不应被创建
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });
  });

  // ============================================
  // AC-005: getUnreadCount
  //
  // #274 起 getUnreadCount 检查 tombstone（deleted:true 行）：
  // markAsRead 追加 tombstone 后该 id 即视为已读，不计入未读数。
  // ============================================
  describe('getUnreadCount', () => {
    it('计算指定用户的非 deleted 通知数量', async () => {
      await service.create({ userId: 'user-1', type: 'system', title: 'N1', content: 'C1' });
      await service.create({ userId: 'user-1', type: 'system', title: 'N2', content: 'C2' });
      await service.create({ userId: 'user-2', type: 'system', title: 'N3', content: 'C3' });

      const count = await service.getUnreadCount('user-1');
      expect(count).toBe(2);
    });

    it('不计算其他用户的通知', async () => {
      await service.create({ userId: 'user-1', type: 'system', title: 'N1', content: 'C1' });
      await service.create({ userId: 'user-2', type: 'system', title: 'N2', content: 'C2' });

      const count = await service.getUnreadCount('user-2');
      expect(count).toBe(1);
    });

    it('空文件返回 0', async () => {
      expect(await service.getUnreadCount('user-1')).toBe(0);
    });

    it('markAsRead 追加 tombstone 后 getUnreadCount 递减（#274）', async () => {
      const n1 = await service.create({ userId: 'user-1', type: 'system', title: 'N1', content: 'C1' });
      const n2 = await service.create({ userId: 'user-1', type: 'system', title: 'N2', content: 'C2' });

      expect(await service.getUnreadCount('user-1')).toBe(2);

      await service.markAsRead(n1.id, 'user-1');
      // 有 tombstone 即已读，不计入未读数
      expect(await service.getUnreadCount('user-1')).toBe(1);
    });
  });
});
