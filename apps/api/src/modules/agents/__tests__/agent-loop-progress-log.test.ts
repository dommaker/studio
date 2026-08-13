// #95 handoff 前序进展段 — recordResult 的 progressLog 环形簿记
// 覆盖：成功步（progress/complete）入 log / summary 截 200 字符 / 最近 5 条环形保留 /
//       failed 与 need_input 不进 log。
// 模式同 agent-loop-milestone-meta.test.ts：真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// CLI 执行 / knowledge-service / pmo-branch-resolver / wu-verification / wu-messenger mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockPostWuSystemMessage } = vi.hoisted(() => ({
  mockPostWuSystemMessage: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
    extractFromConversation: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../requirements/pmo-branch-resolver', () => ({
  resolvePmoBranchForWU: vi.fn().mockResolvedValue(null),
  resolvePmoProjectIdForWU: vi.fn().mockResolvedValue(null),
}));

vi.mock('../loop/wu-verification', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  runWuVerification: vi.fn().mockResolvedValue({ ran: [], source: 'convention' }),
}));

vi.mock('../../workunit/wu-messenger', () => ({
  postWuSystemMessage: mockPostWuSystemMessage,
}));

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-plog',
  name: 'plog-agent',
  description: 'progress log test agent',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
}

type ProgressLogEntry = { step: number; action: string; summary: string; at: string };

describe('#95: recordResult progressLog 环形簿记', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPostWuSystemMessage.mockResolvedValue(null);
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-plog-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const record = async (wuId: string, action: string, summary: string) => {
    const wu = (await wuService.getById(wuId))!;
    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action, summary },
    );
  };

  const progressLogOf = async (wuId: string): Promise<ProgressLogEntry[]> => {
    const wu = (await wuService.getById(wuId))!;
    const meta: WorkUnitMetadata = JSON.parse(wu.metadata ?? '{}');
    return (meta.progressLog ?? []) as ProgressLogEntry[];
  };

  async function createActiveWu(metadata: WorkUnitMetadata = {}) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId: null, type: 'task',
      status: 'active', assigneeId: 'instance-1', metadata,
    });
    return (await wuService.getById(wu.id))!;
  }

  it('progress 步写入 progressLog：step/action/summary/at 齐全，step 按步号递增', async () => {
    const wu = await createActiveWu();

    await record(wu.id, 'progress', '第一步完成');

    const log = await progressLogOf(wu.id);
    expect(log).toHaveLength(1);
    expect(log[0].step).toBe(1);
    expect(log[0].action).toBe('progress');
    expect(log[0].summary).toBe('第一步完成');
    expect(typeof log[0].at).toBe('string');
    expect(Number.isNaN(new Date(log[0].at).getTime())).toBe(false);
  });

  it('complete 步写入 progressLog', async () => {
    const wu = await createActiveWu();

    await record(wu.id, 'progress', '推进中');
    await record(wu.id, 'complete', '全部完成');

    const log = await progressLogOf(wu.id);
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual(expect.objectContaining({ step: 2, action: 'complete', summary: '全部完成' }));
  });

  it('summary 超 200 字符截断为 200', async () => {
    const wu = await createActiveWu();

    await record(wu.id, 'progress', 'x'.repeat(250));

    const log = await progressLogOf(wu.id);
    expect(log[0].summary).toHaveLength(200);
    expect(log[0].summary).toBe('x'.repeat(200));
  });

  it('环形保留最近 5 条（旧到新）', async () => {
    const wu = await createActiveWu();

    for (let i = 1; i <= 7; i++) {
      await record(wu.id, 'progress', `第${i}步`);
    }

    const log = await progressLogOf(wu.id);
    expect(log).toHaveLength(5);
    expect(log.map(e => e.summary)).toEqual(['第3步', '第4步', '第5步', '第6步', '第7步']);
    expect(log.map(e => e.step)).toEqual([3, 4, 5, 6, 7]);
  });

  it('failed 步不进 progressLog', async () => {
    const wu = await createActiveWu({ consecutiveStuck: 0 });

    await record(wu.id, 'progress', '推进中');
    await record(wu.id, 'failed', 'CLI 执行失败: boom');

    const log = await progressLogOf(wu.id);
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('progress');
  });

  it('need_input 步不进 progressLog', async () => {
    const wu = await createActiveWu();

    await record(wu.id, 'progress', '推进中');
    await record(wu.id, 'need_input', '使用 OAuth 还是账号密码？');

    const log = await progressLogOf(wu.id);
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('progress');
  });
});
