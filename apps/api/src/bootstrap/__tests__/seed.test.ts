/**
 * bootstrap/seed 测试（P2-a）：内置 skill 播种——
 * 有 copied/upgraded 时重生成 MANIFEST；失败只 log 不阻断。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-skill', () => ({
  seedBuiltinSkills: vi.fn(),
}));
vi.mock('../../modules/skills/manifest-generator.js', () => ({
  generateManifest: vi.fn(),
}));

import { seedBuiltinSkills } from '@dommaker/studio-skill';
import { generateManifest } from '../../modules/skills/manifest-generator.js';
import { seedBuiltinSkillsStep } from '../seed.js';

const seedMock = vi.mocked(seedBuiltinSkills);
const manifestMock = vi.mocked(generateManifest);

function seededResult(overrides: Partial<Record<string, string[]>> = {}) {
  return {
    copied: [], upgraded: [], skippedUserModified: [], skippedLegacy: [],
    adopted: [], errors: [], ...overrides,
  } as any;
}

beforeEach(() => {
  seedMock.mockReset();
  manifestMock.mockReset();
});

describe('seedBuiltinSkillsStep', () => {
  it('有 copied/upgraded → 重生成 MANIFEST', async () => {
    seedMock.mockReturnValue(seededResult({ copied: ['a'], upgraded: ['b'] }));
    await seedBuiltinSkillsStep();
    expect(manifestMock).toHaveBeenCalledOnce();
  });

  it('无变更 → 不重生成 MANIFEST', async () => {
    seedMock.mockReturnValue(seededResult());
    await seedBuiltinSkillsStep();
    expect(manifestMock).not.toHaveBeenCalled();
  });

  it('seed 抛错 → 不阻断（resolves，不 rethrow）', async () => {
    seedMock.mockImplementation(() => { throw new Error('disk full'); });
    await expect(seedBuiltinSkillsStep()).resolves.toBeUndefined();
  });
});
