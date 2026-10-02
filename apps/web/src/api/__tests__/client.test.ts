// api/client.ts — axios 底座测试（P3-a 拆分）：
// 实例配置 + api/index.ts re-export 同一性（消费方 '../api' 路径拿到的就是 client 实例）。
// 拦截器行为（Bearer 注入 / 401 refresh 队列）全覆盖在 interceptor.test.ts，此处不重复。
import { describe, it, expect } from 'vitest';

// localStorage mock（client 模块级拦截器注册不触读，但 import 链保险）
const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  },
});

import { api, refreshToken } from '../client';
import { api as apiFromIndex, refreshToken as refreshFromIndex } from '../index';

describe('api/client（axios 底座）', () => {
  it('实例配置：baseURL 默认 /api/v1 + JSON 头 + withCredentials', () => {
    expect(api.defaults.baseURL).toBe('/api/v1');
    expect(api.defaults.headers['Content-Type']).toBe('application/json');
    expect(api.defaults.withCredentials).toBe(true);
  });

  it('api/index.ts re-export 同一性：api / refreshToken 均指向 client 本体', () => {
    expect(apiFromIndex).toBe(api);
    expect(refreshFromIndex).toBe(refreshToken);
  });
});
