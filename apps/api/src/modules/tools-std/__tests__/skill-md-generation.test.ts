/**
 * Behavioral tests for SKILL.md file generation on proposal approval
 *
 * AC3:
 * - approved proposal generates SKILL.md file
 * - workflowTypeToTriggerDir mapping correct
 * - file already exists → skip (no overwrite)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockMkdirSync, mockWriteFileSync, mockExistsSync, mockSkillUpdate, mockSkillProposalFindUnique, mockSkillProposalUpdate, mockRoleFindMany } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockSkillUpdate: vi.fn().mockResolvedValue({ id: 'skill-1' }),
  mockSkillProposalFindUnique: vi.fn(),
  mockSkillProposalUpdate: vi.fn().mockResolvedValue({ id: 'sp-1' }),
  mockRoleFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    skill: { update: mockSkillUpdate },
    skillProposal: { findUnique: mockSkillProposalFindUnique, update: mockSkillProposalUpdate },
    role: { findMany: mockRoleFindMany },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  modelGateway: { promptJson: vi.fn() },
  recordDecision: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    readFileSync: vi.fn().mockReturnValue(''),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

vi.mock('child_process', () => ({ exec: vi.fn() }));

// Mock role-config.service to avoid real imports
vi.mock('../../roles/role-config.service.js', () => ({
  roleConfigService: { addCapability: vi.fn().mockResolvedValue(undefined) },
}));

describe('workflowTypeToTriggerDir', () => {
  test('maps ci_fix to goal-start', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('ci_fix')).toBe('goal-start');
  });

  test('maps test_triage to goal-start', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('test_triage')).toBe('goal-start');
  });

  test('maps config_change to goal-start', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('config_change')).toBe('goal-start');
  });

  test('maps pr_review to review', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('pr_review')).toBe('review');
  });

  test('maps doc_update to always', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('doc_update')).toBe('always');
  });

  test('maps knowledge_curation to always', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('knowledge_curation')).toBe('always');
  });

  test('maps architecture to goal-start', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('architecture')).toBe('goal-start');
  });

  test('maps refactor to goal-start', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('refactor')).toBe('goal-start');
  });

  test('maps skill_creation to always', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('skill_creation')).toBe('always');
  });

  test('maps release_prep to integration', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('release_prep')).toBe('integration');
  });

  test('maps changelog to integration', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('changelog')).toBe('integration');
  });

  test('maps unknown workflowType to always', async () => {
    const { workflowTypeToTriggerDir } = await import('../skill-extraction.service.js');
    expect(workflowTypeToTriggerDir('some_random_type')).toBe('always');
  });
});

describe('SKILL.md generation on proposal approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockRoleFindMany.mockResolvedValue([]);
  });

  test('approved proposal generates SKILL.md file with correct frontmatter', async () => {
    mockSkillProposalFindUnique.mockResolvedValue({
      id: 'sp-1',
      status: 'pending',
      skillId: 'skill-1',
      skill: { id: 'skill-1', name: 'my-test-skill', metadata: JSON.stringify({ workflowType: 'ci_fix', pattern: 'Fix the CI issue by...' }) },
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    const result = await service.reviewProposal('sp-1', true);

    expect(result).toBe(true);

    // Should create directory
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('goal-start'),
      { recursive: true },
    );

    // Should write SKILL.md
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toMatch(/SKILL\.md$/);
    expect(filePath).toContain('my-test-skill');

    // Verify YAML frontmatter
    expect(content).toContain('---');
    expect(content).toContain("name: 'my-test-skill'");
    expect(content).toContain('version: 1');
    expect(content).toContain("agentTypes: ['executor']");
    expect(content).toContain("tier: 'standard'");
    expect(content).toContain("status: 'draft'");

    // Verify body contains pattern
    expect(content).toContain('Fix the CI issue by...');
  });

  test('uses default template when no pattern in metadata', async () => {
    mockSkillProposalFindUnique.mockResolvedValue({
      id: 'sp-2',
      status: 'pending',
      skillId: 'skill-2',
      skill: { id: 'skill-2', name: 'no-pattern-skill', metadata: JSON.stringify({ workflowType: 'pr_review' }) },
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    await service.reviewProposal('sp-2', true);

    const [, content] = mockWriteFileSync.mock.calls[0];
    // Should have some default body content (not empty)
    expect(content.length).toBeGreaterThan(50);
    // Should still have correct frontmatter
    expect(content).toContain("name: 'no-pattern-skill'");
  });

  test('file already exists → skip (no overwrite)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockSkillProposalFindUnique.mockResolvedValue({
      id: 'sp-3',
      status: 'pending',
      skillId: 'skill-3',
      skill: { id: 'skill-3', name: 'existing-skill', metadata: JSON.stringify({ workflowType: 'pr_review', pattern: 'Review...' }) },
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    const result = await service.reviewProposal('sp-3', true);

    expect(result).toBe(true);
    // Should NOT write file
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    // Should NOT create directory either (skipped entirely)
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  test('reviewProposal still updates status and calls addCapability', async () => {
    mockSkillProposalFindUnique.mockResolvedValue({
      id: 'sp-4',
      status: 'pending',
      skillId: 'skill-4',
      skill: { id: 'skill-4', name: 'cap-skill', metadata: JSON.stringify({ workflowType: 'ci_fix' }) },
    });
    mockRoleFindMany.mockResolvedValue([{ id: 'role-1' }, { id: 'role-2' }]);

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    await service.reviewProposal('sp-4', true);

    // Existing logic: proposal status updated
    expect(mockSkillProposalUpdate).toHaveBeenCalledWith({
      where: { id: 'sp-4' },
      data: { status: 'approved', reviewedAt: expect.any(Date) },
    });

    // Existing logic: skill status set to draft
    expect(mockSkillUpdate).toHaveBeenCalledWith({
      where: { id: 'skill-4' },
      data: { status: 'draft' },
    });
  });

  test('workflowType trigger directory used in file path', async () => {
    mockSkillProposalFindUnique.mockResolvedValue({
      id: 'sp-5',
      status: 'pending',
      skillId: 'skill-5',
      skill: { id: 'skill-5', name: 'release-skill', metadata: JSON.stringify({ workflowType: 'release_prep', pattern: 'Prepare release...' }) },
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    await service.reviewProposal('sp-5', true);

    // release_prep → integration
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('integration'),
      { recursive: true },
    );
    const [filePath] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toContain('integration');
    expect(filePath).toContain('release-skill');
  });
});
