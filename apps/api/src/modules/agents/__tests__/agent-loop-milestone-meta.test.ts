// 2026-07 PMO-flow UX（§6-3）：里程碑频道消息委托 wu-messenger 的调用契约
// 覆盖：COMPLETE 汇报 / NEED_INPUT / 验证失败打回（verifyFailCount≥3 → blocked）/
//       blocked 转人工（连续 3 步无进展）四类里程碑以 milestone: true + 持久化 wu 本体委托
//       （2026-08 归因统一：不再传「持久化 + 本 step metadataUpdates」合并视图）；
//       普通 progress 消息不带里程碑标记。
// meta 形状（pmoId/atHuman）契约已迁至 workunit/__tests__/wu-messenger.test.ts，本文件只断言委托参数。
// 模式同 agent-loop-need-input.test.ts：真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// CLI 执行 / knowledge-service / pmo-branch-resolver / wu-verification / wu-messenger mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight, mockRunWuVerification, mockPostWuSystemMessage } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockRunWuVerification: vi.fn(),
  mockPostWuSystemMessage: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../requirements/pmo-branch-resolver', () => ({
  resolvePmoBranchForWU: vi.fn().mockResolvedValue(null),
  resolvePmoProjectIdForWU: vi.fn().mockResolvedValue(null),
}));

vi.mock('../loop/wu-verification', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  runWuVerification: mockRunWuVerification,
}));

vi.mock('../../workunit/wu-messenger', () => ({
  postWuSystemMessage: mockPostWuSystemMessage,
}));

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-ms',
  name: 'ms-agent',
  description: 'milestone meta test agent',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
}

/** 按消息文本定位一次 wu-messenger 委托调用 */
function findCall(content: string | RegExp) {
  return mockPostWuSystemMessage.mock.calls.find(c =>
    typeof content === 'string' ? c[1] === content : content.test(String(c[1])));
}

describe('AgentLoop 里程碑消息委托 wu-messenger（2026-07 §6-3）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPostWuSystemMessage.mockResolvedValue(null);
    mockRunWuVerification.mockResolvedValue({ ran: [], source: 'convention' });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-ms-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-ms-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#ms-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 创建 active WorkUnit（@mention 派发形态） */
  async function setupActiveWorkUnit(metadata?: WorkUnitMetadata) {
    return wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
      ...(metadata ? { metadata } : {}),
    });
  }

  it('COMPLETE 完成汇报 → milestone: true + role.name 署名 + loop fileStore，消息文本不变', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '登录功能已完成' },
    );

    const call = findCall('登录功能已完成');
    expect(call).toBeDefined();
    expect(call![0]).toEqual(expect.objectContaining({ id: wu.id, channelId }));
    expect(call![2]).toEqual(expect.objectContaining({
      agentName: 'ms-agent',
      milestone: true,
      fileStore,
    }));
    // 状态迁移不变（COMPLETE → in_review）
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('里程碑 wu 参数为持久化 wu 本体（2026-08 归因统一：解析链只读创建期落档，不再传本 step 合并视图）', async () => {
    const wu = await setupActiveWorkUnit({ title: '登录' });

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '登录功能已完成', metadataUpdates: { lastCommitHash: 'abc123' } },
    );

    const call = findCall('登录功能已完成');
    expect(call).toBeDefined();
    const wuArgMeta = JSON.parse(String(call![0].metadata)) as WorkUnitMetadata;
    expect(wuArgMeta.title).toBe('登录');               // 持久化字段在
    expect(wuArgMeta.lastCommitHash).toBeUndefined();   // 本 step metadataUpdates 不再并入 wu 参数
  });

  it('NEED_INPUT → milestone: true，消息文本不变', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '使用 OAuth 还是账号密码？' },
    );

    const call = findCall('需要输入: 使用 OAuth 还是账号密码？');
    expect(call).toBeDefined();
    expect(call![2]).toEqual(expect.objectContaining({ milestone: true }));
  });

  it('验证失败打回（verifyFailCount≥3 → blocked）→ milestone: true', async () => {
    mockRunWuVerification.mockResolvedValue({
      ran: [],
      source: 'convention',
      failure: { command: 'pnpm run test', tail: '1 failing test' },
    });
    const wu = await setupActiveWorkUnit({ worktreePath: '/tmp/wt-ms', verifyFailCount: 2 });

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '登录功能已完成' },
    );

    const call = findCall(/自动验证连续失败/);
    expect(call).toBeDefined();
    expect(call![2]).toEqual(expect.objectContaining({ milestone: true }));
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('blocked 转人工（连续 3 步无进展）→ milestone: true', async () => {
    const wu = await setupActiveWorkUnit({ consecutiveStuck: 2 });

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '又卡住了' },
    );

    const call = findCall(/连续 3 步无进展/);
    expect(call).toBeDefined();
    expect(call![2]).toEqual(expect.objectContaining({ milestone: true }));
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('普通 progress 消息不带里程碑标记', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'progress', summary: '已完成第一步' },
    );

    const call = findCall('已完成第一步');
    expect(call).toBeDefined();
    expect(call![0]).toEqual(expect.objectContaining({ id: wu.id }));
    expect(call![2].milestone).toBeUndefined();
    expect(call![2]).toEqual(expect.objectContaining({ agentName: 'ms-agent', fileStore }));
  });
});
