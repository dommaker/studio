/**
 * skill-store → manifest-generator 联动测试
 *
 * 写入 SKILL.md 后调用 generateManifest() 重新生成 MANIFEST.md（best-effort）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => {
  const store = new Map<string, string>();
  return {
    existsSync: vi.fn((p: string) => store.has(p)),
    readFileSync: vi.fn((p: string) => store.get(p) || '[]'),
    writeFileSync: vi.fn((p: string, data: string) => { store.set(p, data); }),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    __store: store,
    __reset: () => store.clear(),
  };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../manifest-generator.js', () => ({
  generateManifest: vi.fn(),
}));

import * as fs from 'fs';
import { SkillStore } from '../skill-store.js';
import { generateManifest } from '../manifest-generator.js';

const fsStore = (fs as any).__store;
const fsReset = (fs as any).__reset;

describe('SkillStore SKILL.md 写入触发 MANIFEST 重新生成', () => {
  let store: SkillStore;

  beforeEach(() => {
    vi.clearAllMocks();
    fsReset();
    store = new SkillStore();
    store.invalidateCache();
  });

  it('create with prompt writes SKILL.md and calls generateManifest', () => {
    store.create({ companyId: 'comp-1', name: 'new-skill', prompt: 'do something' });

    const skillMdPath = Object.keys(Object.fromEntries(fsStore)).find(p => p.endsWith('new-skill/SKILL.md'));
    expect(skillMdPath).toBeDefined();
    expect(generateManifest).toHaveBeenCalledTimes(1);
  });

  it('create without prompt does not call generateManifest', () => {
    store.create({ companyId: 'comp-1', name: 'no-prompt-skill' });
    expect(generateManifest).not.toHaveBeenCalled();
  });

  it('does not throw when generateManifest throws (best-effort)', () => {
    vi.mocked(generateManifest).mockImplementationOnce(() => {
      throw new Error('manifest boom');
    });
    expect(() => store.create({ companyId: 'comp-1', name: 'resilient-skill', prompt: 'x' })).not.toThrow();
  });
});
