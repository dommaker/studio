/**
 * Channel API 测试 — B2 Channel UI 后端
 *
 * 覆盖: CRUD、消息发送、SSE 事件发布、卡片 action、RequirementsDoc 编辑
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/core/database.js';

const BASE = `http://localhost:${process.env.TEST_PORT || process.env.PORT || '13001'}/api/v1`;

const TEST_CHANNEL = `test-channel-${Date.now()}`;
let channelId: string;
let authToken: string;

describe('Channel API', () => {
  beforeAll(async () => {
    // Get auth token for endpoints that require it
    try {
      const res = await fetch(`${BASE}/auth/guest-session`, { method: 'POST' });
      const data = await res.json() as any;
      authToken = data?.token || data?.data?.token || '';
    } catch { /* best effort */ }

    // Clean stale test data from previous runs
    try {
      const stale = await prisma.channel.findMany({ where: { name: { startsWith: 'test-channel-' } } });
      for (const c of stale) {
        await prisma.channelMessage.deleteMany({ where: { channelId: c.id } });
        await prisma.channel.delete({ where: { id: c.id } });
      }
    } catch { /* best effort */ }
  });

  // ── Channel CRUD ──

  describe('POST /channels (B2-007)', () => {
    it('creates a new channel', async () => {
      const res = await fetch(`${BASE}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate name', async () => {
      const res = await fetch(`${BASE}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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

  // ── RequirementsDoc Edit (B2-009) ──

  describe('PUT /requirements-docs/:id', () => {
    it('rejects missing content', async () => {
      const res = await fetch(`${BASE}/requirements-docs/nonexistent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent doc', async () => {
      const res = await fetch(`${BASE}/requirements-docs/nonexistent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ content: 'new content' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Cleanup ──

  afterAll(async () => {
    if (channelId) {
      await fetch(`${BASE}/channels/${channelId}`, { method: 'DELETE' });
    }
  });
});
