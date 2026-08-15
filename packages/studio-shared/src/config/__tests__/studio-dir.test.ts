/**
 * studio-dir — STUDIO_HOME 数据根解析单入口测试
 *
 * 覆盖：env 优先级（STUDIO_HOME > ~/.studio）、studioPath 拼接、
 * warnIfNonProdUsesProdRoot 三种场景（production 不警告 / 指向其他根不警告 /
 * 非 prod 指向缺省根警告且每进程仅一次）。
 *
 * warn 每进程一次由模块级 flag 实现，每个 warn 用例前 vi.resetModules() + 动态 import
 * 拿到全新模块实例；process.env 改动在 finally 中恢复。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'os';
import osDefault from 'node:os';
import * as path from 'path';
import { defaultStudioDir, studioDir, studioPath, specsDir, legacySddDir } from '../studio-dir';

const ENV_KEYS = ['STUDIO_HOME', 'NODE_ENV'] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

function saveEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

describe('defaultStudioDir()', () => {
  it('返回 ~/.studio（os.homedir 动态读 $HOME）', () => {
    expect(defaultStudioDir()).toBe(path.join(os.homedir(), '.studio'));
  });
});

describe('studioDir()', () => {
  it('STUDIO_HOME 设置时优先', () => {
    saveEnv();
    try {
      process.env.STUDIO_HOME = '/tmp/custom-studio-root';
      expect(studioDir()).toBe('/tmp/custom-studio-root');
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });

  it('STUDIO_HOME 未设置时回退 ~/.studio', () => {
    saveEnv();
    try {
      delete process.env.STUDIO_HOME;
      expect(studioDir()).toBe(path.join(os.homedir(), '.studio'));
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });

  it('STUDIO_HOME 为空字符串时回退 ~/.studio', () => {
    saveEnv();
    try {
      process.env.STUDIO_HOME = '';
      expect(studioDir()).toBe(path.join(os.homedir(), '.studio'));
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });
});

describe('studioPath()', () => {
  it('拼接数据根与相对段', () => {
    saveEnv();
    try {
      delete process.env.STUDIO_HOME;
      expect(studioPath('data', 'tasks')).toBe(path.join(os.homedir(), '.studio', 'data', 'tasks'));
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });

  it('无 segment 时返回数据根本身', () => {
    saveEnv();
    try {
      process.env.STUDIO_HOME = '/tmp/custom-studio-root';
      expect(studioPath()).toBe('/tmp/custom-studio-root');
      expect(studioPath('skills')).toBe(path.join('/tmp/custom-studio-root', 'skills'));
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });
});

describe('specsDir()', () => {
  it('拼接 <repoRoot>/.studio/specs', () => {
    expect(specsDir('/repo/x')).toBe(path.join('/repo/x', '.studio', 'specs'));
  });

  it('repoRoot 为空/非字符串时抛错（归属链断裂不兜底）', () => {
    expect(() => specsDir('')).toThrow();
    expect(() => specsDir(undefined as unknown as string)).toThrow();
    expect(() => specsDir(null as unknown as string)).toThrow();
  });
});

describe('legacySddDir()', () => {
  it('拼接 <repoRoot>/.studio/legacy-sdd', () => {
    expect(legacySddDir('/repo/x')).toBe(path.join('/repo/x', '.studio', 'legacy-sdd'));
  });

  it('repoRoot 为空/非字符串时抛错', () => {
    expect(() => legacySddDir('')).toThrow();
    expect(() => legacySddDir(undefined as unknown as string)).toThrow();
  });
});

describe('resolveHomedir 双视图兼容', () => {
  it('C 类隔离（vi.spyOn os 默认导出 homedir）：studioDir/studioPath 跟随 spy 值', () => {
    saveEnv();
    try {
      delete process.env.STUDIO_HOME;
      vi.spyOn(osDefault, 'homedir').mockReturnValue('/tmp/spied-home');
      expect(defaultStudioDir()).toBe(path.join('/tmp/spied-home', '.studio'));
      expect(studioDir()).toBe(path.join('/tmp/spied-home', '.studio'));
      expect(studioPath('data')).toBe(path.join('/tmp/spied-home', '.studio', 'data'));
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });
});

describe('warnIfNonProdUsesProdRoot()', () => {
  async function freshModule(): Promise<typeof import('../studio-dir')> {
    vi.resetModules();
    return import('../studio-dir');
  }

  it('production 环境指向缺省根：不警告', async () => {
    saveEnv();
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.STUDIO_HOME;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mod = await freshModule();
      mod.warnIfNonProdUsesProdRoot();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });

  it('非 production 指向其他根（STUDIO_HOME 已设置）：不警告', async () => {
    saveEnv();
    try {
      process.env.NODE_ENV = 'test';
      process.env.STUDIO_HOME = '/tmp/custom-studio-root';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mod = await freshModule();
      mod.warnIfNonProdUsesProdRoot();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });

  it('非 production 指向缺省根：警告且每进程仅一次', async () => {
    saveEnv();
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.STUDIO_HOME;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mod = await freshModule();
      mod.warnIfNonProdUsesProdRoot();
      mod.warnIfNonProdUsesProdRoot();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.STUDIO_HOME;
    }
  });
});
