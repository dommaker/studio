/**
 * Channel API 测试 — B2 Channel UI 后端
 *
 * 覆盖: CRUD、消息发送、SSE 事件发布、卡片 action
 *
 * 集成测试性质: 依赖运行中的 API 服务器 + Prisma 数据库。
 * CI 中无运行服务器时自动 skip;本地/e2e 环境有服务器时自动运行。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// prisma import removed (Spec 4 Phase 4) — database.ts deleted, all data in FileStore

const BASE = `http://localhost:${process.env.TEST_PORT || process.env.PORT || '13001'}/api/v1`;

// 检测 API 服务器是否可用(CI 中可能未启动)
async function checkServerAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(`${BASE.replace('/api/v1', '')}/health`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

const serverAvailable = await checkServerAvailable();

const TEST_CHANNEL = `test-channel-${Date.now()}`;
let channelId: string;
let authToken: string;

// 集成测试: 依赖运行中的 API 服务器 + Prisma 数据库。
// CI 中默认不启动 API 服务器,检测到服务器不可用时自动 skip。
// 本地或 e2e 环境启动服务器后自动运行。
describe.skipIf(!serverAvailable)('Channel API', () => {
  beforeAll(async () => {
    // Register a non-guest test user for auth-required endpoints (requireNotGuest)
    const testEmail = `test-channel-api-${Date.now()}@test.studio`;
    try {
      const res = await fetch(`${BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: process.env.TEST_USER_PASSWORD || 'Test1234!', name: 'Channel API Test' }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        authToken = data?.token || '';
      }
    } catch { /* best effort */ }
    // DB cleanup removed (Spec 4 Phase 4) — FileStore handles data via API
  });

  // ── Channel CRUD ──

  describe('POST /channels (B2-007)', () => {
    it('creates a new channel', async () => {
      const res = await fetch(`${BASE}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ name: TEST_CHANNEL, type: 'rnd' }),
      });
      const data = await res.json() as any;
      expect(res.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.name).toContain('test-channel');
      channelId = data.data.id;
    });

    it('rejects empty name', async () => {
      const res = await fetch(`${BASE}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate name', async () => {
      const res = await fetch(`${BASE}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ name: TEST_CHANNEL, type: 'rnd' }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('GET /channels', () => {
    it('lists channels', async () => {
      const res = await fetch(`${BASE}/channels`);
      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });
  });

  // ── Messages ──

  describe('POST /channels/:id/messages', () => {
    it('sends a message', async () => {
      const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ content: 'Hello from test' }),
      });
      const data = await res.json() as any;
      expect(res.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.content).toBe('Hello from test');
    });

    it('rejects empty content', async () => {
      const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ content: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /channels/:id/messages', () => {
    it('lists messages with pagination', async () => {
      const res = await fetch(`${BASE}/channels/${channelId}/messages`);
      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
      expect(typeof data.hasMore).toBe('boolean');
      expect(typeof data.total).toBe('number');
    });
  });

  // ── Cleanup ──

  afterAll(async () => {
    if (channelId) {
      await fetch(`${BASE}/channels/${channelId}`, {
        method: 'DELETE',
        headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      });
    }
  });
});
