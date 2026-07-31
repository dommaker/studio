// 2026-07 PMO-flow UX（§6-3）：里程碑频道消息 meta（pmoId / atHuman）
// 覆盖：COMPLETE 汇报 / NEED_INPUT / 验证失败打回（verifyFailCount≥3 → blocked）/
//       blocked 转人工（连续 3 步无进展）四类里程碑 meta 带 pmoId + atHuman；
//       pmoId 解析不到时不携带；普通 progress 消息不带 meta。
// 模式同 agent-loop-need-input.test.ts：真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// CLI 执行 / knowledge-service / pmo-branch-resolver / wu-verification mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight, mockResolvePmoProjectId, mockRunWuVerification } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockResolvePmoProjectId: vi.fn(),
  mockRunWuVerification: vi.fn(),
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
  resolvePmoProjectIdForWU: mockResolvePmoProjectId,
}));

vi.mock('../wu-verification', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  runWuVerification: mockRunWuVerification,
}));

import { AgentLoop } from '../agent-loop';

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

function parseMeta(msg: ChannelMessageData): Record<string, unknown> {
  return JSON.parse(msg.meta) as Record<string, unknown>;
}

describe('AgentLoop 里程碑消息 meta（2026-07 §6-3）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolvePmoProjectId.mockResolvedValue('proj-1');
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

  /** 创建 active WorkUnit（@mention 派发形态，含 anchor 消息） */
  async function setupActiveWorkUnit(metadata?: WorkUnitMetadata) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1',
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@ms-agent 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return wu;
  }

  async function agentMessages(wuId: string): Promise<ChannelMessageData[]> {
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wuId });
    return messages.filter(m => m.authorType === 'agent');
  }

  it('COMPLETE 完成汇报 → meta 带 pmoId + atHuman，消息文本不变', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '登录功能已完成' },
    );

    const report = (await agentMessages(wu.id)).find(m => m.content === '登录功能已完成');
    expect(report).toBeDefined();
    expect(parseMeta(report!)).toEqual({ pmoId: 'proj-1', atHuman: true });
    // 状态迁移不变（COMPLETE → in_review）
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('NEED_INPUT → meta 带 pmoId + atHuman，消息文本不变', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '使用 OAuth 还是账号密码？' },
    );

    const question = (await agentMessages(wu.id)).find(m => m.content.includes('需要输入'));
    expect(question).toBeDefined();
    expect(question!.content).toBe('需要输入: 使用 OAuth 还是账号密码？');
    expect(parseMeta(question!)).toEqual({ pmoId: 'proj-1', atHuman: true });
  });

  it('验证失败打回（verifyFailCount≥3 → blocked）→ meta 带 pmoId + atHuman', async () => {
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

    const notice = (await agentMessages(wu.id)).find(m => m.content.includes('自动验证连续失败'));
    expect(notice).toBeDefined();
    expect(parseMeta(notice!)).toEqual({ pmoId: 'proj-1', atHuman: true });
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('blocked 转人工（连续 3 步无进展）→ meta 带 pmoId + atHuman', async () => {
    const wu = await setupActiveWorkUnit({ consecutiveStuck: 2 });

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'need_input', summary: '又卡住了' },
    );

    const notice = (await agentMessages(wu.id)).find(m => m.content.includes('连续 3 步无进展'));
    expect(notice).toBeDefined();
    expect(parseMeta(notice!)).toEqual({ pmoId: 'proj-1', atHuman: true });
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('pmoId 解析不到 → meta 不携带 pmoId（atHuman 仍在）', async () => {
    mockResolvePmoProjectId.mockResolvedValue(null);
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '登录功能已完成' },
    );

    const report = (await agentMessages(wu.id)).find(m => m.content === '登录功能已完成');
    expect(report).toBeDefined();
    const meta = parseMeta(report!);
    expect(meta.atHuman).toBe(true);
    expect('pmoId' in meta).toBe(false);
  });

  it('普通 progress 消息不带 meta（非里程碑）', async () => {
    const wu = await setupActiveWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'progress', summary: '已完成第一步' },
    );

    const progress = (await agentMessages(wu.id)).find(m => m.content === '已完成第一步');
    expect(progress).toBeDefined();
    const meta = parseMeta(progress!);
    expect('pmoId' in meta).toBe(false);
    expect('atHuman' in meta).toBe(false);
  });
});
