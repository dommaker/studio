// @ts-nocheck
/**
 * TaskQueue 测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock memoryStore
const mockMemoryStore = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  setex: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  mget: vi.fn().mockResolvedValue([]),
  keys: vi.fn().mockResolvedValue([]),
  hset: vi.fn().mockResolvedValue(undefined),
  hget: vi.fn().mockResolvedValue(null),
  hgetall: vi.fn().mockResolvedValue({}),
  lpush: vi.fn().mockResolvedValue(1),
  rpush: vi.fn().mockResolvedValue(1),
  lpop: vi.fn().mockResolvedValue(null),
  blpop: vi.fn().mockResolvedValue(null),
  lrem: vi.fn().mockResolvedValue(0),
  llen: vi.fn().mockResolvedValue(0),
  zadd: vi.fn().mockResolvedValue(undefined),
  zrangebyscore: vi.fn().mockResolvedValue([]),
  zrem: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
};

// Mock @dommaker/studio-shared — TaskQueue 从此模块 import memoryStore
// 部分 mock：memoryStore/logger 用 mock，FileStore 等其余导出保持真实实现
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    memoryStore: mockMemoryStore,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

describe('TaskQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 恢复默认 mock 返回值
    mockMemoryStore.lpop.mockResolvedValue(null);
    mockMemoryStore.hget.mockResolvedValue(null);
    mockMemoryStore.rpush.mockResolvedValue(1);
    mockMemoryStore.hset.mockResolvedValue(undefined);
    mockMemoryStore.lrem.mockResolvedValue(1);
    mockMemoryStore.publish.mockResolvedValue(undefined);
    mockMemoryStore.quit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('RETRY_CONFIG', () => {
    it('重试配置正确', async () => {
      const { RETRY_CONFIG } = await import('../task-queue');

      expect(RETRY_CONFIG.maxRetries).toBe(3);
      expect(RETRY_CONFIG.retryDelay).toBe(5000);
      expect(RETRY_CONFIG.backoffMultiplier).toBe(2);
      expect(RETRY_CONFIG.maxRetryDelay).toBe(60000);
    });
  });

  describe('TaskQueue class', () => {
    it('TaskQueue 类导出正确', async () => {
      const { TaskQueue } = await import('../task-queue');

      expect(TaskQueue).toBeDefined();
      expect(TaskQueue.name).toBe('TaskQueue');
    });

    it('taskQueue 单例导出正确', async () => {
      const { taskQueue } = await import('../task-queue');

      expect(taskQueue).toBeDefined();
      expect(taskQueue.constructor.name).toBe('TaskQueue');
    });
  });

  describe('TaskQueue methods', () => {
    const makeTask = (overrides = {}) => ({
      id: 'task-1',
      executionId: 'ex-1',
      nodeId: 'node-1',
      agentType: 'solo-developer',
      prompt: 'test prompt',
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    it('getPendingTask 返回待处理任务', async () => {
      const taskData = makeTask();
      // lpop 返回 taskId
      mockMemoryStore.lpop.mockResolvedValueOnce('task-1');
      // hget 在 getTask 中被调一次，claimTask 中 updateTask 又调一次
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));

      const { taskQueue } = await import('../task-queue');

      const task = await taskQueue.getPendingTask();

      expect(task).toBeDefined();
      expect(task?.id).toBe('task-1');
      expect(task?.agentType).toBe('solo-developer');
      expect(mockMemoryStore.lpop).toHaveBeenCalledWith('tasks:pending');
      expect(mockMemoryStore.rpush).toHaveBeenCalledWith('tasks:running', 'task-1');
    });

    it('getPendingTask 队列空返回 null', async () => {
      mockMemoryStore.lpop.mockResolvedValueOnce(null);

      const { taskQueue } = await import('../task-queue');

      const task = await taskQueue.getPendingTask();

      expect(task).toBeNull();
    });

    it('updateTask 更新任务进度', async () => {
      const taskData = makeTask({ status: 'running' });
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));

      const { taskQueue } = await import('../task-queue');

      await taskQueue.updateTask('task-1', {
        progress: 50,
        message: '正在处理...',
      });

      // 验证 hget 被调用读取任务
      expect(mockMemoryStore.hget).toHaveBeenCalledWith('task:', 'task-1');
      // 验证 hset 被调用写入更新
      expect(mockMemoryStore.hset).toHaveBeenCalledWith(
        'task:',
        'task-1',
        expect.stringContaining('"progress":50'),
      );
      expect(mockMemoryStore.hset).toHaveBeenCalledWith(
        'task:',
        'task-1',
        expect.stringContaining('正在处理...'),
      );
    });

    it('completeTask 完成任务', async () => {
      const taskData = makeTask({ status: 'running' });
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));

      const { taskQueue } = await import('../task-queue');

      await taskQueue.completeTask('task-1', { result: 'success' });

      expect(mockMemoryStore.lrem).toHaveBeenCalledWith('tasks:running', 0, 'task-1');
      expect(mockMemoryStore.rpush).toHaveBeenCalledWith('tasks:completed', 'task-1');
      expect(mockMemoryStore.hset).toHaveBeenCalledWith(
        'task:',
        'task-1',
        expect.stringContaining('"status":"succeeded"'),
      );
    });

    it('failTask 标记失败', async () => {
      // attempts=3 + 1 = 4 ≥ maxAttempts(3+1=4) → failed
      // failTask 内部调两次 getTask: 直接调用 + updateTask 内调用
      const taskData = makeTask({ status: 'running', attempts: 3 });
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));
      mockMemoryStore.hget.mockResolvedValueOnce(JSON.stringify(taskData));

      const { taskQueue } = await import('../task-queue');

      const result = await taskQueue.failTask('task-1', '执行失败');

      expect(mockMemoryStore.lrem).toHaveBeenCalledWith('tasks:running', 0, 'task-1');
      expect(result).toBeDefined();
      expect(result?.status).toBe('failed');
    });

    it('subscribeEvents 订阅事件', async () => {
      const { taskQueue } = await import('../task-queue');

      const handler = vi.fn();
      await taskQueue.subscribeEvents(handler);

      expect(mockMemoryStore.subscribe).toHaveBeenCalledWith(
        'events:task',
        expect.any(Function),
      );
    });

    it('close 关闭连接', async () => {
      const { taskQueue } = await import('../task-queue');

      await taskQueue.close();

      expect(mockMemoryStore.quit).toHaveBeenCalled();
    });
  });

  describe('Task types', () => {
    it('Task 接口定义正确', async () => {
      const { Task } = await import('../task-queue');

      const task: Task = {
        id: 'test-id',
        executionId: 'ex-1',
        nodeId: 'node-1',
        agentType: 'solo-developer',
        prompt: 'test prompt',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      expect(task.id).toBe('test-id');
      expect(task.status).toBe('pending');
    });

    it('TaskEvent 接口定义正确', async () => {
      const { TaskEvent } = await import('../task-queue');

      const event: TaskEvent = {
        event_type: 'task.start',
        task_id: 'task-1',
        execution_id: 'ex-1',
        node_id: 'node-1',
        status: 'running',
        timestamp: new Date().toISOString(),
      };

      expect(event.event_type).toBe('task.start');
      expect(event.task_id).toBe('task-1');
    });
  });
});
