// Prisma 测试 mock
import { vi } from 'vitest';

// 定义 mock 函数
const mockPrisma = {
  workflow: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  workflowVersion: {
    create: vi.fn(),
  },
  execution: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  agent: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  $disconnect: vi.fn(),
  $connect: vi.fn(),
};

// Mock 必须在导入前声明
vi.mock('express', () => ({
  default: vi.fn(() => ({
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    json: vi.fn(),
  })),
  Router: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  })),
}));

export { mockPrisma };