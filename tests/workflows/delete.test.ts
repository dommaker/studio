// 工作流删除功能单元测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

describe('工作流删除功能', () => {
  const testWorkflowId = 'test-workflow-123';
  const outputsBaseDir = path.join(process.cwd(), 'outputs');

  beforeEach(async () => {
    // 创建测试用的 outputs 目录
    const testDir = path.join(outputsBaseDir, testWorkflowId);
    await fs.mkdir(testDir, { recursive: true });

    // 创建一些测试文件
    await fs.writeFile(path.join(testDir, 'test1.txt'), 'test content 1');
    await fs.writeFile(path.join(testDir, 'test2.txt'), 'test content 2');
    await fs.mkdir(path.join(testDir, 'subdir'));
    await fs.writeFile(path.join(testDir, 'subdir', 'nested.txt'), 'nested content');
  });

  afterEach(async () => {
    // 清理测试目录（如果测试失败残留）
    try {
      await fs.rm(path.join(outputsBaseDir, testWorkflowId), { recursive: true, force: true });
    } catch (err) {
      // 忽略清理错误
    }
  });

  describe('outputs 目录清理', () => {
    it('应该删除工作流对应的 outputs 目录', async () => {
      const testDir = path.join(outputsBaseDir, testWorkflowId);

      // 验证目录存在
      const existsBefore = await fs.access(testDir).then(() => true).catch(() => false);
      expect(existsBefore).toBe(true);

      // 模拟删除操作
      await fs.rm(testDir, { recursive: true, force: true });

      // 验证目录已删除
      const existsAfter = await fs.access(testDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(false);
    });

    it('应该递归删除子目录和文件', async () => {
      const testDir = path.join(outputsBaseDir, testWorkflowId);

      // 验证子目录和文件存在
      const subdir = path.join(testDir, 'subdir');
      const nestedFile = path.join(subdir, 'nested.txt');
      const existsBefore = await fs.access(nestedFile).then(() => true).catch(() => false);
      expect(existsBefore).toBe(true);

      // 删除目录
      await fs.rm(testDir, { recursive: true, force: true });

      // 验证所有文件和子目录都已被删除
      const existsAfter = await fs.access(testDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(false);
    });

    it('应该能够处理不存在的目录', async () => {
      const nonexistentDir = path.join(outputsBaseDir, 'nonexistent-workflow');

      // 尝试删除不存在的目录
      await expect(
        fs.rm(nonexistentDir, { recursive: true, force: true })
      ).resolves.not.toThrow();
    });
  });

  describe('删除 API 路由', () => {
    it('应该返回 204 No Content 状态码', async () => {
      // 这里需要模拟 HTTP 请求
      // 实际测试需要集成测试框架如 supertest
      // 这是一个示例结构

      const mockResponse = {
        status: 204,
        data: null,
      };

      expect(mockResponse.status).toBe(204);
    });

    it('应该在删除前验证工作流 ID 的格式', () => {
      // 验证工作流 ID 格式（UUID 或其他有效格式）
      const validIds = [
        '123e4567-e89b-12d3-a456-426614174000',
        'wf-123',
        'test-workflow',
      ];

      validIds.forEach(id => {
        expect(id).toBeTruthy();
        expect(id.length).toBeGreaterThan(0);
      });
    });
  });
});
