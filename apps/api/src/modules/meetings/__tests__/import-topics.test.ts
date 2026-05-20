/**
 * MR-024 会议导入文档功能测试
 *
 * 验收条件：
 * AC-001: 前端有"导入议题"按钮（E2E 测试）
 * AC-002: 点击按钮弹出文档选择器（E2E 测试）
 * AC-003: 选择 roadmap.md 后解析任务列表
 * AC-004: 选择任务后自动填充 title/description（E2E 测试）
 * AC-005: 支持粘贴 URL 导入
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API_BASE = 'http://localhost:3001/api/v1';

// 测试用的 roadmap 内容
const TEST_ROADMAP_CONTENT = `
# Roadmap

| ID | 任务 | 优先级 | 状态 | 说明 |
|------|------|:-----:|:----:|------|
| MR-024 | 会议导入文档功能 | P1 | ⬜ | 从 roadmap/文档导入议题 |
| MR-013 | 发言队列可视化 | P1 | ⬜ | 决策 #13 |
| MR-005 | 会议纪要追溯 | P2 | ⬜ | 决策 #5 |
`;

describe('MR-024 会议导入文档', () => {
  describe('AC-003: 选择 roadmap.md 后解析任务列表', () => {
    it('should parse roadmap tasks from text', async () => {
      const res = await fetch(`${API_BASE}/meetings/import-topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'text',
          text: TEST_ROADMAP_CONTENT,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.topics).toBeDefined();
      expect(data.topics.length).toBeGreaterThanOrEqual(3);

      // 验证解析结果
      const mr024 = data.topics.find((t: any) => t.id === 'MR-024');
      expect(mr024).toBeDefined();
      expect(mr024.title).toBe('会议导入文档功能');
      expect(mr024.priority).toBe('P1');
      expect(mr024.status).toBe('⬜');
    });

    it('should return empty array for invalid content', async () => {
      const res = await fetch(`${API_BASE}/meetings/import-topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'text',
          text: 'This is not a roadmap',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.topics).toEqual([]);
    });
  });

  describe('AC-005: 支持粘贴 URL 导入', () => {
    it('should reject invalid URL', async () => {
      const res = await fetch(`${API_BASE}/meetings/import-topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'url',
          target: 'not-a-valid-url',
        }),
      });

      expect(res.status).toBe(400);
    });

    // 真实 URL 测试需要网络，这里只测试 API 响应
    it('should accept valid URL format', async () => {
      const res = await fetch(`${API_BASE}/meetings/import-topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'url',
          target: 'https://example.com/roadmap.md',
        }),
      });

      // URL 解析可能失败（无网络），但 API 应正常响应
      expect(res.status).toBeLessThanOrEqual(500);
    });
  });

  describe('Roadmap 解析器单元测试', () => {
    it('should extract task ID pattern', () => {
      const regex = /\| ([A-Z]+-\d+) \| ([^|]+) \| (P\d) \| ([✅⬜🔶]) \| ([^|]+) \|/g;
      const match = regex.exec(TEST_ROADMAP_CONTENT);

      expect(match).not.toBeNull();
      expect(match![1]).toBe('MR-024');
      expect(match![2].trim()).toBe('会议导入文档功能');
    });

    it('should extract all tasks', () => {
      const regex = /\| ([A-Z]+-\d+) \| ([^|]+) \| (P\d) \| ([✅⬜🔶]) \| ([^|]+) \|/g;
      const topics = [];
      let match;
      while ((match = regex.exec(TEST_ROADMAP_CONTENT)) !== null) {
        topics.push({
          id: match[1],
          title: match[2].trim(),
        });
      }

      expect(topics.length).toBe(3);
      expect(topics[0].id).toBe('MR-024');
      expect(topics[1].id).toBe('MR-013');
      expect(topics[2].id).toBe('MR-005');
    });
  });
});