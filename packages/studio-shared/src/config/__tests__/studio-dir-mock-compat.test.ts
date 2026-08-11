/**
 * studio-dir — resolveHomedir 双视图兼容：A 类隔离风格
 *
 * vi.mock('node:os') 工厂 {...actual, homedir} 只作用于 namespace 视图
 * （audit-service / notification-service / agent-registry 等现存测试的隔离方式）。
 * 断言 studioDir()/studioPath() 的缺省回退跟随 mockHome 而非真实 homedir。
 *
 * vi.mock 提升于一切 import 之前；vi.resetModules + 动态 import 显式拿到
 * 被 mock 后求值的 studio-dir 模块实例。
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';

const mockHome = vi.hoisted(() => '/tmp/studio-dir-mock-home');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

describe('studio-dir A 类隔离兼容（vi.mock namespace 风格）', () => {
  it('defaultStudioDir/studioDir/studioPath 缺省回退跟随 mockHome', async () => {
    const savedStudioHome = process.env.STUDIO_HOME;
    try {
      delete process.env.STUDIO_HOME;
      vi.resetModules();
      const mod = await import('../studio-dir');
      expect(mod.defaultStudioDir()).toBe(path.join(mockHome, '.studio'));
      expect(mod.studioDir()).toBe(path.join(mockHome, '.studio'));
      expect(mod.studioPath('data', 'tasks')).toBe(path.join(mockHome, '.studio', 'data', 'tasks'));
    } finally {
      if (savedStudioHome === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = savedStudioHome;
    }
  });
});
