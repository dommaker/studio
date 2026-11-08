// AC-5: PMO Publish API tests — Spec 3 FileStore 版本
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReadJson,
  mockWriteJson,
  mockCreateHumanMessage,
  mockCreateAgentMessage,
  mockUpdateMessageMeta,
  mockLinkWorkUnit,
  mockWuCreate,
  mockGetChannel,
  mockGetProfile,
} = vi.hoisted(() => ({
  mockReadJson: vi.fn(),
  mockWriteJson: vi.fn().mockResolvedValue(undefined),
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
  mockCreateAgentMessage: vi.fn().mockResolvedValue({ id: 'msg-sys-1' }),
  mockUpdateMessageMeta: vi.fn().mockResolvedValue({
    id: 'msg-1',
    meta: { pmoId: 'proj-1' },
  }),
  mockLinkWorkUnit: vi.fn().mockResolvedValue({
    id: 'msg-1',
    workUnitId: 'wu-1',
    meta: { pmoId: 'proj-1' },
  }),
  mockWuCreate: vi.fn().mockResolvedValue({
    id: 'wu-1',
    type: 'plan',
    scope: 'test',
    status: 'unassigned',
  }),
  // #466 路由表：缺省无配置（null = 频道不存在/无路由），行为与存量一致
  mockGetChannel: vi.fn().mockResolvedValue(null),
  mockGetProfile: vi.fn().mockResolvedValue(null),
}));

// Mock FileStore
vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () { return {
      readJson: mockReadJson,
      writeJson: mockWriteJson,
      readJsonl: vi.fn().mockResolvedValue([]),
      getChannel: mockGetChannel,
      getProfile: mockGetProfile,
    }; }),
  };
});

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...(actual as object),
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  };
});

// Mock channelMessageService
vi.mock('../../channels/channel-message.service.js', () => ({
  getChannelMessageService: () => ({
    createHumanMessage: (...args: unknown[]) => mockCreateHumanMessage(...args),
    createAgentMessage: (...args: unknown[]) => mockCreateAgentMessage(...args),
    updateMessageMeta: (...args: unknown[]) => mockUpdateMessageMeta(...args),
    linkWorkUnit: (...args: unknown[]) => mockLinkWorkUnit(...args),
  }),
}));

// Mock WorkUnitService
vi.mock('../../workunit/workunit-review.js', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    create: (...args: unknown[]) => mockWuCreate(...args),
  }; }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { publishProject } from '../publish-project.js';

function sampleProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    pmoNumber: 'PM-001',
    title: 'Test Project',
    description: null,
    requirement: 'Test requirement',
    companyId: null,
    okrId: null,
    status: 'pending',
    priority: 'normal',
    progress: 0,
    gitBranch: null,
    gitRepo: null,
    specFilePath: null,
    requirementsDocId: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('AC-5: PMO Publish API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJson.mockResolvedValue(sampleProject());
    // #466：缺省无路由配置（各用例自行覆盖，避免泄漏）
    mockGetChannel.mockResolvedValue(null);
    mockGetProfile.mockResolvedValue(null);
  });

  it('pending PMO publish creates ChannelMessage + WorkUnit + status→active', async () => {
    const result = await publishProject({
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

  it('#177：可选 assigneeId 落 plan WU（留空 = 不带该字段，回池涌现）', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1', assigneeId: 'profile-7' });
    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan', assigneeId: 'profile-7' })
    );

    mockWuCreate.mockClear();
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    const input = mockWuCreate.mock.calls[0][0] as Record<string, unknown>;
    expect('assigneeId' in input).toBe(false);
  });

  it('non-pending PMO → error，且不发消息、不建 WU、不写项目', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ status: 'active' }));

    await expect(
      publishProject({ projectId: 'proj-1', channelId: 'ch-1' })
    ).rejects.toThrow();
    expect(mockCreateHumanMessage).not.toHaveBeenCalled();
    expect(mockWuCreate).not.toHaveBeenCalled();
    expect(mockWriteJson).not.toHaveBeenCalled();
  });

  it('project not found → error，且不发消息、不建 WU、不写项目', async () => {
    mockReadJson.mockResolvedValue(null);

    await expect(
      publishProject({ projectId: 'nope', channelId: 'ch-1' })
    ).rejects.toThrow();
    expect(mockCreateHumanMessage).not.toHaveBeenCalled();
    expect(mockWuCreate).not.toHaveBeenCalled();
    expect(mockWriteJson).not.toHaveBeenCalled();
  });

  it('WorkUnit metadata contains pmoId and pmoNumber', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan',
        metadata: expect.objectContaining({
          pmoId: 'proj-1',
          pmoNumber: 'PM-001',
        }),
      })
    );
  });

  it('#700：PMO 原消息与 plan WU 双向关联，plan 携带 REQ 与消息锚点', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ reqAlias: 'REQ-0001' }));

    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockWuCreate).toHaveBeenCalledWith(expect.objectContaining({
      reqId: 'REQ-0001',
      metadata: expect.objectContaining({ anchorMessageId: 'msg-1' }),
    }));
    expect(mockLinkWorkUnit).toHaveBeenCalledWith('msg-1', 'wu-1', 'ch-1');
  });

  it('#471：plan WU scope 首行钉 +requirement-clarify +to-tickets（方法论跟活走）', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    const firstLine = scope.split('\n')[0]!;
    expect(firstLine).toContain('+requirement-clarify');
    expect(firstLine).toContain('+to-tickets');
  });

  it('#471：plan WU 落单独 token 额度（默认 1_000_000，env STUDIO_PLAN_TOKEN_BUDGET 可覆盖）', async () => {
    const prev = process.env.STUDIO_PLAN_TOKEN_BUDGET;
    try {
      delete process.env.STUDIO_PLAN_TOKEN_BUDGET;
      await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
      expect(mockWuCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ tokenBudget: 1_000_000 }),
        })
      );

      mockWuCreate.mockClear();
      process.env.STUDIO_PLAN_TOKEN_BUDGET = '250000';
      await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
      expect(mockWuCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ tokenBudget: 250_000 }),
        })
      );
    } finally {
      if (prev === undefined) delete process.env.STUDIO_PLAN_TOKEN_BUDGET;
      else process.env.STUDIO_PLAN_TOKEN_BUDGET = prev;
    }
  });

  it('B3a 归属链：gitRepo 落 metadata.workspaceRoot；无 gitRepo 不带该字段', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ gitRepo: '/repo/demo' }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ workspaceRoot: '/repo/demo' }),
      })
    );

    mockWuCreate.mockClear();
    mockReadJson.mockResolvedValue(sampleProject({ gitRepo: null }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    const meta = mockWuCreate.mock.calls[0][0].metadata as Record<string, unknown>;
    expect('workspaceRoot' in meta).toBe(false);
  });

  it('#471：plan scope 含一脉会话契约 + TASK 输出约定 + FOG/DESTINATION 待决清单约定（不再是只读分析）', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('一脉会话');
    expect(scope).toContain('.studio/specs/');
    expect(scope).toContain('TASK: <任务描述> | LEG: <gitRepo> | AC: <验收标准> | BLOCKEDBY: <wuId,...>');
    expect(scope).toContain('每条 TASK 必须且只能归属一条 LEG、至少一条 AC');
    expect(scope).toContain('无依赖时写 BLOCKEDBY: none');
    expect(scope).toContain('ACTION: NEED_INPUT');
    expect(scope).toContain('不得默认选择第一仓');
    expect(scope).toContain('FOG:');
    expect(scope).toContain('DESTINATION:');
    expect(scope).not.toContain('只读分析');
    expect(scope).not.toContain('禁止创建/修改/删除任何文件');
  });

  it('ChannelMessage meta contains pmoId', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockUpdateMessageMeta).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({ pmoId: 'proj-1' }),
      'ch-1',
    );
  });

  it('#273（#251 决议）：publish 回写 project.channelId 并持久化（发布即绑定，1 PMO : 1 频道）', async () => {
    const result = await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(result.project.channelId).toBe('ch-1');
    expect(mockWriteJson).toHaveBeenCalledWith(
      expect.stringContaining('proj-1'),
      expect.objectContaining({ status: 'active', channelId: 'ch-1' })
    );
  });

  it('PMO status transitions to active', async () => {
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    // publish calls updateStatus which calls writeJson with status='active'
    expect(mockWriteJson).toHaveBeenCalledWith(
      expect.stringContaining('proj-1'),
      expect.objectContaining({ status: 'active' })
    );
  });

  it('#282：新项目只有 description（requirement=null）→ 消息正文与分析单 scope 回退用 description', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ requirement: null, description: '需求背景与验收标准' }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockCreateHumanMessage).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('需求背景与验收标准')
    );
    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('需求背景与验收标准');
  });

  it('#282：存量项目 requirement 有值 → 仍用 requirement（既有数据读取兼容不变）', async () => {
    mockReadJson.mockResolvedValue(sampleProject({ requirement: '旧需求正文', description: '新描述' }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    expect(mockCreateHumanMessage).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('旧需求正文')
    );
    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('旧需求正文');
    expect(scope).not.toContain('新描述');
  });

  it('#701 多腿：plan 输入逐腿包含仓库路径与 delivery branch', async () => {
    mockReadJson.mockResolvedValue(sampleProject({
      gitRepo: '/repo/leg-a',
      deliveries: [
        { gitRepo: '/repo/leg-a', branch: 'PMO-1-a', status: 'pending' },
        { gitRepo: '/repo/leg-b', branch: 'PMO-1-b', status: 'pending' },
        { gitRepo: '/repo/leg-c', branch: null, status: 'pending' },
      ],
    }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('- LEG: /repo/leg-a | DELIVERY BRANCH: PMO-1-a');
    expect(scope).toContain('- LEG: /repo/leg-b | DELIVERY BRANCH: PMO-1-b');
    expect(scope).toContain('- LEG: /repo/leg-c | DELIVERY BRANCH: （未设置交付分支）');
    expect(scope).toContain('只读');
  });

  it('#701 单腿：无 deliveries 字段也注入合成腿的仓库与 delivery branch', async () => {
    mockReadJson.mockResolvedValue(sampleProject({
      gitRepo: '/repo/demo',
      gitBranch: 'PMO-custom',
    }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('## 交付腿');
    expect(scope).toContain('- LEG: /repo/demo | DELIVERY BRANCH: PMO-custom');
    expect(scope).toContain('一脉会话');
  });

  it('#701 单腿：显式 deliveries 同样注入仓库与 delivery branch', async () => {
    mockReadJson.mockResolvedValue(sampleProject({
      deliveries: [{ gitRepo: '/repo/only', branch: 'PMO-1', status: 'pending' }],
    }));
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });

    const scope = mockWuCreate.mock.calls[0][0].scope as string;
    expect(scope).toContain('- LEG: /repo/only | DELIVERY BRANCH: PMO-1');
  });

  // ── #466: 频道路由表 plan 档 ──

  it('#466：频道配置 routing.plan 且未显式指派 → plan WU 落路由角色', async () => {
    mockGetChannel.mockResolvedValue({
      id: 'ch-1', members: '["p-planner"]', routing: { plan: 'p-planner' },
    });
    mockGetProfile.mockResolvedValue({
      id: 'p-planner', name: 'planner', status: 'active', channels: '[]',
    });
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan', assigneeId: 'p-planner' })
    );
  });

  it('#466：显式 assigneeId 优先于 routing.plan', async () => {
    mockGetChannel.mockResolvedValue({
      id: 'ch-1', members: '["p-planner"]', routing: { plan: 'p-planner' },
    });
    mockGetProfile.mockResolvedValue({
      id: 'p-planner', name: 'planner', status: 'active', channels: '[]',
    });
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1', assigneeId: 'profile-7' });
    expect(mockWuCreate).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'profile-7' })
    );
  });

  it('#466：路由角色 inactive → 回池涌现（不带 assigneeId）+ 频道出声提醒', async () => {
    mockGetChannel.mockResolvedValue({
      id: 'ch-1', members: '["p-planner"]', routing: { plan: 'p-planner' },
    });
    mockGetProfile.mockResolvedValue({
      id: 'p-planner', name: 'planner', status: 'inactive', channels: '[]',
    });
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    const input = mockWuCreate.mock.calls[0][0] as Record<string, unknown>;
    expect('assigneeId' in input).toBe(false);
    expect(mockCreateAgentMessage).toHaveBeenCalledWith(
      'ch-1', 'Studio', expect.stringContaining('planner'), expect.anything()
    );
  });

  it('#466：路由角色被移出频道 → 回池涌现 + 频道出声提醒', async () => {
    mockGetChannel.mockResolvedValue({
      id: 'ch-1', members: '["p-other"]', routing: { plan: 'p-planner' },
    });
    mockGetProfile.mockResolvedValue({
      id: 'p-planner', name: 'planner', status: 'active', channels: '[]',
    });
    await publishProject({ projectId: 'proj-1', channelId: 'ch-1' });
    const input = mockWuCreate.mock.calls[0][0] as Record<string, unknown>;
    expect('assigneeId' in input).toBe(false);
    expect(mockCreateAgentMessage).toHaveBeenCalledWith(
      'ch-1', 'Studio', expect.stringContaining('planner'), expect.anything()
    );
  });
});
