// 测试设置文件
import { vi } from 'vitest';

// 设置测试超时
vi.setConfig({
  testTimeout: 10000,
  hookTimeout: 10000,
});