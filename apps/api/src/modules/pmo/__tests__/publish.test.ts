// AC-5: PMO Publish API tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockProjectFindUnique,
  mockProjectUpdate,
  mockCreateHumanMessage,
  mockUpdateMessageMeta,
  mockWuCreate,
} = vi.hoisted(() => ({
  mockProjectFindUnique: vi.fn(),
  mockProjectUpdate: vi.fn(),
  mockCreateHumanMessage: vi.fn().mockResolvedValue({
    id: 'msg-1',
    channelId: 'ch-1',
    content: 'test',
    authorType: 'human',
    agentName: null,
    workUnitId: null,
    replyToId: null,
    meta: {},
    createdAt: new Date(),
  }),
  mockUpdateMessageMeta: vi.fn().mockResolvedValue({
    id: 'msg-1',
    meta: { pmoId: 'proj-1' },
  }),
  mockWuCreate: vi.fn().mockResolvedValue({
    id: 'wu-1',
    type: 'analysis',
    scope: 'test',
    status: 'unassigned',
  }),
}));

// Mock prisma
vi.mock('../../../core/database.js', () => ({
  prisma: {
    project: {
      findUnique: mockProjectFindUnique,
      update: mockProjectUpdate,
    },
  },
}));

// Mock channelMessageService
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createHumanMessage: mockCreateHumanMessage,
    updateMessageMeta: mockUpdateMessageMeta,
  },
}));

// Mock WorkUnitService
vi.mock('../../workunit/workunit.service.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(() => ({
    create: mockWuCreate,
  })),
}));

import { projectService } from '../project.service.js';

describe('AC-5: PMO Publish API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectFindUnique.mockResolvedValue({
      id: 'proj-1',
      pmoNumber: 'PM-001',
      title: 'Test Project',
      requirement: 'Test requirement',
      status: 'pending',
    });
    mockProjectUpdate.mockResolvedValue({
      id: 'proj-1',
      status: 'active',
    });
  });

  it('pending PMO publish creates ChannelMessage + WorkUnit + status→active', async () => {
    const result = await projectService.publish({
      projectId: 'proj-1',
      channelId: 'ch-1',
    });

    expect(result.message).toBeDefined();
    expect(result.workUnit).toBeDefined();
    expect(result.project).toBeDefined();
    expect(mockCreateHumanMessage).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('PM-001')
    );
  });

  it('non-pending PMO → error', async () => {
    mockProjectFindUnique.mockResolvedValue({
      id: 'proj-1',
      status: 'active',
      pmoNumber: 'PM-001',
      title: 'Active',
    });

    await expect(
      projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' })
    ).rejects.toThrow();
  });

  it('project not found → error', async () => {
    mockProjectFindUnique.mockResolvedValue(null);

    await expect(
      projectService.publish({ projectId: 'nope', channelId: 'ch-1' })
    ).rejects.toThrow();
  });

  it('WorkUnit metadata contains pmoId and pmoNumber', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'analysis',
        metadata: expect.objectContaining({
          pmoId: 'proj-1',
          pmoNumber: 'PM-001',
        }),
      })
    );
  });

  it('ChannelMessage meta contains pmoId', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockUpdateMessageMeta).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ pmoId: 'proj-1' })
    );
  });

  it('PMO status transitions to active', async () => {
    await projectService.publish({ projectId: 'proj-1', channelId: 'ch-1' });

    // updateStatus internally calls prisma.project.update
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proj-1' },
        data: expect.objectContaining({ status: 'active' }),
      })
    );
  });
});
