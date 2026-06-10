/**
 * Behavioral tests for Skill event emission (S3 post-gap 3c)
 *
 * AC:
 * - saveProposal creates skill → emits knowledge:skill_created { skillName, skillId }
 * - loadSkill succeeds → emits knowledge:skill_used { skillName }
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockStudioEventCreate, mockSkillCreate, mockSkillProposalCreate, mockSkillFindFirst } = vi.hoisted(() => ({
  mockStudioEventCreate: vi.fn().mockResolvedValue({ id: 'evt-1' }),
  mockSkillCreate: vi.fn().mockResolvedValue({ id: 'skill-1', name: 'test-skill' }),
  mockSkillProposalCreate: vi.fn().mockResolvedValue({ id: 'sp-1' }),
  mockSkillFindFirst: vi.fn().mockResolvedValue({ id: 'skill-1', name: 'test-skill', prompt: 'do stuff', tools: '[]', tier: 'standard' }),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: { create: mockStudioEventCreate },
    skill: {
      create: mockSkillCreate,
      findFirst: mockSkillFindFirst,
    },
    skillProposal: { create: mockSkillProposalCreate },
    goalExecution: { findUnique: vi.fn() },
    goal: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  modelGateway: { promptJson: vi.fn() },
  recordDecision: vi.fn(),
}));

// Mock fs for skill-loader file-based loading
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

vi.mock('child_process', () => ({ exec: vi.fn() }));

describe('Skill event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStudioEventCreate.mockResolvedValue({ id: 'evt-1' });
    mockSkillCreate.mockResolvedValue({ id: 'skill-1', name: 'test-skill' });
    mockSkillProposalCreate.mockResolvedValue({ id: 'sp-1' });
    mockSkillFindFirst.mockResolvedValue({ id: 'skill-1', name: 'test-skill', prompt: 'do stuff', tools: '[]', tier: 'standard' });
  });

  test('saveProposal emits knowledge:skill_created', async () => {
    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();

    await service.saveProposal({
      id: 'p1',
      skillId: 's1',
      companyId: 'c1',
      name: 'Test Skill',
      description: 'A test skill',
      category: 'implementation',
      pattern: 'pattern text',
      sourceGoalIds: ['g1'],
      confidence: 0.9,
      status: 'pending',
      createdAt: new Date(),
    });

    const skillCreatedCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:skill_created',
    );
    expect(skillCreatedCall).toBeDefined();
    const payload = JSON.parse(skillCreatedCall[0].data.payload);
    expect(payload.skillName).toBe('Test Skill');
  });

  test('loadSkill emits knowledge:skill_used', async () => {
    // Need to mock prisma differently for skill-loader
    // skill-loader imports prisma from @dommaker/studio-prisma (already mocked above)
    // and also uses loadSkillFromDisk which reads from filesystem (mocked)

    // Reset the mock to track calls for this test
    mockStudioEventCreate.mockClear();

    const { SkillLoaderService } = await import('../../skills/skill-loader.js');
    const loader = new SkillLoaderService();

    // loadSkill tries file-based first (returns null due to mock),
    // then falls back to Prisma (returns from mockSkillFindFirst)
    const result = await loader.loadSkill({
      sessionId: 'sess-1',
      skillName: 'test-skill',
    });

    // Skill should be loaded from Prisma mock
    expect(result).not.toBeNull();

    const skillUsedCall = mockStudioEventCreate.mock.calls.find(
      (c: any[]) => c[0].data.type === 'knowledge:skill_used',
    );
    expect(skillUsedCall).toBeDefined();
    const payload = JSON.parse(skillUsedCall[0].data.payload);
    expect(payload.skillName).toBe('test-skill');
  });
});
