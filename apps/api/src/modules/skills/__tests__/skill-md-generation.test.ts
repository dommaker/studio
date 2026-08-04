/**
 * Behavioral tests for SKILL.md file generation on proposal approval
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockMkdirSync, mockWriteFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
}));

const { mockProposalGet, mockProposalUpdate, mockSkillGet, mockSkillUpdate } = vi.hoisted(() => ({
  mockProposalGet: vi.fn(),
  mockProposalUpdate: vi.fn(),
  mockSkillGet: vi.fn(),
  mockSkillUpdate: vi.fn(),
}));

vi.mock('../../skills/proposal-store.js', () => ({
  proposalStore: {
    get: mockProposalGet,
    update: mockProposalUpdate,
  },
}));

vi.mock('../../skills/skill-store.js', () => ({
  skillStore: {
    get: mockSkillGet,
    update: mockSkillUpdate,
  },
}));

const mockFileStoreInstance = vi.hoisted(() => ({
  getIndex: vi.fn().mockResolvedValue([]),
  upsertSnapshot: vi.fn().mockResolvedValue(undefined),
  appendEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  FileStore: vi.fn().mockImplementation(function () { return mockFileStoreInstance; }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
  };
});

describe('SKILL.md generation on proposal approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  test('approved proposal generates SKILL.md at flat path with correct frontmatter', async () => {
    mockProposalGet.mockReturnValue({
      id: 'sp-1',
      status: 'pending',
      skillId: 'skill-1',
    });
    mockSkillGet.mockReturnValue({
      id: 'skill-1',
      name: 'my-test-skill',
      metadata: JSON.stringify({ pattern: 'Fix the CI issue by...' }),
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    const result = await service.reviewProposal('sp-1', true);

    expect(result).toBe(true);

    // Flat path (no trigger subdir)
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/skills[/\\]my-test-skill$/),
      { recursive: true },
    );

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toMatch(/SKILL\.md$/);
    expect(filePath).toContain('my-test-skill');

    // Frontmatter: no trigger field
    expect(content).toContain("name: 'my-test-skill'");
    expect(content).toContain('version: 1');
    expect(content).toContain("status: 'draft'");
    expect(content).not.toContain('trigger:');
    expect(content).toContain('Fix the CI issue by...');
  });

  test('file already exists → skip', async () => {
    mockExistsSync.mockReturnValue(true);
    mockProposalGet.mockReturnValue({
      id: 'sp-2',
      status: 'pending',
      skillId: 'skill-2',
    });
    mockSkillGet.mockReturnValue({
      id: 'skill-2',
      name: 'existing-skill',
      metadata: JSON.stringify({}),
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    const result = await service.reviewProposal('sp-2', true);

    expect(result).toBe(true);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  test('updates proposal and skill status', async () => {
    mockProposalGet.mockReturnValue({
      id: 'sp-3',
      status: 'pending',
      skillId: 'skill-3',
    });
    mockSkillGet.mockReturnValue({
      id: 'skill-3',
      name: 'cap-skill',
      metadata: JSON.stringify({}),
    });

    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();
    await service.reviewProposal('sp-3', true);

    expect(mockProposalUpdate).toHaveBeenCalledWith('sp-3', {
      status: 'approved',
      reviewedAt: expect.any(String),
    });
    expect(mockSkillUpdate).toHaveBeenCalledWith('skill-3', { status: 'draft' });
  });
});
