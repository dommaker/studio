// AC-10: PMO-SDD association query tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockProjectFindUnique,
  mockExistsSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockProjectFindUnique: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('../../../core/database.js', () => ({
  prisma: {
    project: {
      findUnique: mockProjectFindUnique,
    },
  },
}));

// Mock channelMessageService and WorkUnitService (needed by project.service imports)
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createHumanMessage: vi.fn(),
    updateMessageMeta: vi.fn(),
  },
}));

vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
  })),
}));

// Partial mock of fs — keep other fs functions intact
vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

import { projectService } from '../project.service.js';

describe('AC-10: PMO-SDD association query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectFindUnique.mockResolvedValue({
      id: 'proj-1',
      pmoNumber: 'PM-001',
      title: 'Test',
      status: 'active',
    });
  });

  it('matching SDD entries returned', async () => {
    const indexContent = [
      'other-slug | PM-999 | done | Other | []',
      'my-slug | PM-001 | confirmed | My SDD | ["a"]',
    ].join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(indexContent);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toHaveLength(1);
    expect(result.sddEntries[0]).toMatchObject({ slug: 'my-slug', pmoNumber: 'PM-001' });
  });

  it('no match → empty array', async () => {
    const indexContent = 'other-slug | PM-999 | done | Other | []';

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(indexContent);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
  });

  it('index file not found → empty array', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await projectService.getLinkedSDDs('proj-1');

    expect(result.sddEntries).toEqual([]);
  });

  it('project not found → throws', async () => {
    mockProjectFindUnique.mockResolvedValue(null);

    await expect(projectService.getLinkedSDDs('nope')).rejects.toThrow();
  });
});
