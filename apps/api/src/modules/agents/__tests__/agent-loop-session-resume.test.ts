// #94 会话号 per-WU 化与续用降级：agent-loop 续用判定只信档案 metadata.sessionId
// （实例单槽位废弃——并行互踩 + 重启孤儿化）。claude 额外要求会话文件
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl 存在（cwd = 本步最终 workspaceRoot）；
// 续用步报「会话不存在」→ 换发新 sessionId 降级重试一次。
// HOME 经 vi.stubEnv 指向 tmpdir 造会话文件；真实 FileStore（tmpdir）+ 真实 WorkUnitService；
// CLI 执行与 workspace 解析 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { AgentTask } from '@dommaker/studio-agent';
import { claudeCwdSlug } from '../loop/session-resume.js';

const { mockResolveWorkspaceRoot } = vi.hoisted(() => ({
  mockResolveWorkspaceRoot: vi.fn(),
}));

vi.mock('../../workspaces/workspace-store', () => ({
  resolveWorkspaceRoot: mockResolveWorkspaceRoot,
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
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

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-resume',
  name: 'resume-agent',
  description: 'session resume test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface AgentStepCapable {
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
  recordResult(target: unknown, result: unknown): Promise<void>;
}

interface InstanceHolder {
  instance: { id: string; sessionId: string | null } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** workspace 解析 mock 的统一返回值 = 本步最终 cwd（无 .git，不走 worktree 分支） */
const FAKE_CWD = '/tmp/fake-worktree';

const SUCCESS_RESULT = {
  success: true, outputText: 'ACTION: PROGRESS:继续',
  logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
};

describe('#94: 会话号 per-WU 化与续用降级', () => {
  let testDir: string;
  let homeDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-resume-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-home-'));
    vi.stubEnv('HOME', homeDir);
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-resume-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#resume-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
    mockResolveWorkspaceRoot.mockResolvedValue(FAKE_CWD);
    mockExecuteLightweight.mockResolvedValue({ ...SUCCESS_RESULT });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  async function setupWorkUnit(metadata?: WorkUnitMetadata) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1', workspaceId: 'ws-1',
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: 'anchor-1', channelId, authorType: 'human', agentName: null,
      content: '@resume-agent 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return wu;
  }

  /** 在 stub 的 HOME 下造 claude 会话文件（<cwd-slug>/<sessionId>.jsonl） */
  function createClaudeSessionFile(sessionId: string, cwd = FAKE_CWD): void {
    const dir = path.join(homeDir, '.claude', 'projects', claudeCwdSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');
  }

  /** 注入带初始 sessionId 的 RuntimeInstance state（验证 agent-loop 不再读写该槽位） */
  async function injectInstance(sessionId: string | null): Promise<string> {
    const instanceId = 'inst-resume-1';
    await fileStore.createState(instanceId, {
      id: instanceId, roleId: mockRole.id, sessionId,
      status: 'idle', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null,
      lastHeartbeat: null, metadata: null, pid: process.pid,
    });
    (agentLoop as unknown as InstanceHolder).instance = {
      id: instanceId, sessionId,
    } as InstanceHolder['instance'];
    return instanceId;
  }

  function taskAt(index: number): AgentTask {
    return mockExecuteLightweight.mock.calls.at(index)![0] as AgentTask;
  }

  function lastTask(): AgentTask {
    return taskAt(-1);
  }

  it('无 metadata.sessionId → 新建：claude 传新 UUID、无 sessionResume、lastSessionResumed=false', async () => {
    const wu = await setupWorkUnit();

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionId).toMatch(UUID_RE);
    expect(task.parameters?.sessionResume).toBeUndefined();
    expect(step.metadataUpdates?.sessionCount).toBe(1);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(false);
  });

  it('metadata.sessionId + 会话文件在 → 续用：sessionResume=true、sessionResumes=1、lastSessionResumed=true', async () => {
    createClaudeSessionFile('sess-wu1');
    const wu = await setupWorkUnit({ sessionId: 'sess-wu1', sessionCount: 1 });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionId).toBe('sess-wu1');
    expect(task.parameters?.sessionResume).toBe(true);
    expect(step.metadataUpdates?.sessionResumes).toBe(1);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(true);
    // 续用不重新签发 sessionId、不消耗新会话额度
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    expect(step.metadataUpdates).not.toHaveProperty('sessionCount');
  });

  it('metadata.sessionId 有但会话文件缺（claude）→ 新建分支：sessionCount 1→2、lastSessionResumed=false', async () => {
    const wu = await setupWorkUnit({ sessionId: 'sess-gone', sessionCount: 1 });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const task = lastTask();
    expect(task.parameters?.sessionResume).toBeUndefined();
    expect(task.parameters?.sessionId).toMatch(UUID_RE);
    expect(task.parameters?.sessionId).not.toBe('sess-gone');
    expect(step.metadataUpdates?.sessionId).toBe(task.parameters?.sessionId);
    expect(step.metadataUpdates?.sessionCount).toBe(2);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(false);
  });

  it('并行互踩回归：同 loop 交替执行各有 sessionId 的 WU-A/WU-B → 各自续用自己的号', async () => {
    createClaudeSessionFile('sess-a');
    createClaudeSessionFile('sess-b');
    const wuA = await setupWorkUnit({ sessionId: 'sess-a', sessionCount: 1 });
    const wuB = await setupWorkUnit({ sessionId: 'sess-b', sessionCount: 1 });

    const stepA1 = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wuA });
    const stepB = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wuB });
    const stepA2 = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wuA });

    expect(taskAt(0).parameters?.sessionId).toBe('sess-a');
    expect(taskAt(0).parameters?.sessionResume).toBe(true);
    expect(taskAt(1).parameters?.sessionId).toBe('sess-b');
    expect(taskAt(1).parameters?.sessionResume).toBe(true);
    expect(taskAt(2).parameters?.sessionId).toBe('sess-a');
    expect(taskAt(2).parameters?.sessionResume).toBe(true);
    for (const step of [stepA1, stepB, stepA2]) {
      expect(step.metadataUpdates?.lastSessionResumed).toBe(true);
    }
  });

  it('重启场景：loop 无 instance 槽位（this.instance=null）+ metadata.sessionId + 文件在 → 续用', async () => {
    createClaudeSessionFile('sess-survives-restart');
    // 不 injectInstance —— AgentLoop 未 start()，this.instance 为 null（等价重启后新实例 sessionId=null）
    const wu = await setupWorkUnit({ sessionId: 'sess-survives-restart', sessionCount: 1 });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(lastTask().parameters?.sessionId).toBe('sess-survives-restart');
    expect(lastTask().parameters?.sessionResume).toBe(true);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(true);
  });

  it('kimi：metadata.sessionId 在（无文件可查）→ 续用传 sessionId + sessionResume；新建不传 sessionId', async () => {
    const kimiLoop = new AgentLoop({ ...mockRole, provider: 'kimi' } as typeof mockRole, fileStore);

    // 新建：不传 sessionId（kimi --session 是续用语义，对未使用 id 会报错，CLI 自建会话）
    const wu = await setupWorkUnit();
    const step1 = await (kimiLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });
    expect(lastTask().parameters?.sessionId).toBeUndefined();
    expect(lastTask().parameters?.sessionResume).toBeUndefined();
    expect(step1.metadataUpdates?.lastSessionResumed).toBe(false);
    const sessionId = step1.metadataUpdates?.sessionId;
    expect(typeof sessionId).toBe('string');

    // 同一 WU 第二步：档案有号即续用（kimi 无 id 文件可查，cli-adapter 侧转 --continue）
    await wuService.update(wu.id, { metadata: { sessionId: sessionId!, sessionCount: 1 } });
    const wu2 = (await wuService.getById(wu.id))!;
    const step2 = await (kimiLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu2 });
    expect(lastTask().parameters?.sessionId).toBe(sessionId);
    expect(lastTask().parameters?.sessionResume).toBe(true);
    expect(step2.metadataUpdates?.lastSessionResumed).toBe(true);
  });

  it('instance 槽位不再读写：新建后 fileStore 里的 state.sessionId 仍为初始值', async () => {
    const instanceId = await injectInstance('sess-stale');
    const wu = await setupWorkUnit();

    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    const state = await fileStore.getState(instanceId);
    expect(state?.sessionId).toBe('sess-stale');
    expect((agentLoop as unknown as InstanceHolder).instance?.sessionId).toBe('sess-stale');
  });

  it('首 step（新建）执行失败 → 重置 sessionId 但 sessionCount 计入（#95），下一步按新建重试', async () => {
    const wu = await setupWorkUnit();
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI boom', logFile: '/tmp/log', worktree: '/tmp/wt',
      outputFiles: [], sessionCount: 1,
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(step.action).toBe('failed');
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    expect(step.metadataUpdates!.sessionCount).toBe(1);

    // 下一步重新按新建签发
    mockExecuteLightweight.mockResolvedValue({ ...SUCCESS_RESULT });
    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: (await wuService.getById(wu.id))! });
    expect(lastTask().parameters?.sessionId).toMatch(UUID_RE);
    expect(lastTask().parameters?.sessionResume).toBeUndefined();
  });

  it('续用步报「会话不存在」→ 降级：换发新 UUID 重试一次（无 sessionResume），成功后落新号 + sessionCount+1 + lastSessionResumed=false', async () => {
    createClaudeSessionFile('sess-lost');
    const wu = await setupWorkUnit({ sessionId: 'sess-lost', sessionCount: 1 });
    // 降级重试复用同一 task 对象改 parameters（#94 设计）——首次调用形态需在调用时快照
    let firstCallParams: AgentTask['parameters'] | undefined;
    mockExecuteLightweight.mockImplementationOnce(async (task: AgentTask) => {
      firstCallParams = { ...task.parameters };
      return {
        success: false, error: 'No conversation found with session ID sess-lost',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      };
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    // 第一次：续用形态；第二次：新建形态（claude 传新 UUID、不带 sessionResume）
    expect(firstCallParams?.sessionId).toBe('sess-lost');
    expect(firstCallParams?.sessionResume).toBe(true);
    const retryParams = taskAt(1).parameters!;
    expect(retryParams.sessionId).toMatch(UUID_RE);
    expect(retryParams.sessionId).not.toBe('sess-lost');
    expect(retryParams.sessionResume).toBeUndefined();
    // 降级成功：metadata 落新号、sessionCount+1、lastSessionResumed=false
    expect(step.action).toBe('progress');
    expect(step.metadataUpdates?.sessionId).toBe(retryParams.sessionId);
    expect(step.metadataUpdates?.sessionCount).toBe(2);
    expect(step.metadataUpdates?.lastSessionResumed).toBe(false);
    // 续用实际失败 → sessionResumes 不计（#94 起只计实际续用成功的步）
    expect(step.metadataUpdates).not.toHaveProperty('sessionResumes');
  });

  it('续用步报非续用类错误（CLI boom）→ 不触发降级重试，action=failed', async () => {
    createClaudeSessionFile('sess-wu1');
    const wu = await setupWorkUnit({ sessionId: 'sess-wu1', sessionCount: 1 });
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI boom', logFile: '/tmp/log', worktree: '/tmp/wt',
      outputFiles: [], sessionCount: 1,
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    expect(step.action).toBe('failed');
  });

  it('降级重试仍失败 → action=failed，sessionId/lastSessionResumed 回滚、sessionCount 计入（#95）', async () => {
    createClaudeSessionFile('sess-lost');
    const wu = await setupWorkUnit({ sessionId: 'sess-lost', sessionCount: 1 });
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'No conversation found with session ID sess-lost',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    expect(step.action).toBe('failed');
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    expect(step.metadataUpdates!.sessionCount).toBe(2);
    expect(step.metadataUpdates).not.toHaveProperty('lastSessionResumed');
  });

  it('#95: 续用降级（check 判命中、执行才发现会话丢失）→ 重试 prompt 注入前序进展段', async () => {
    createClaudeSessionFile('sess-lost');
    const wu = await setupWorkUnit({
      sessionId: 'sess-lost', sessionCount: 1, stepCount: 2,
      progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
    });
    // 首次调用（续用形态）报「会话不存在」→ 触发降级；重试走默认成功。
    // 降级复用同一 task 对象改 prompt（#95）——首次 prompt 需在调用时快照（对象引用会被改写）。
    let firstPrompt: string | undefined;
    mockExecuteLightweight.mockImplementationOnce(async (task: AgentTask) => {
      firstPrompt = task.prompt;
      return {
        success: false, error: 'No conversation found with session ID sess-lost',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      };
    });

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(2);
    expect(step.action).toBe('progress');
    // 首次（续用形态）不注入；降级重试（新建形态）注入前序进展
    expect(firstPrompt).not.toContain('## 前序进展');
    expect(taskAt(1).prompt).toContain('## 前序进展');
    expect(taskAt(1).prompt).toContain('完成数据层');
  });

  it('续用步抛异常（spawn 失败）→ catch 分支不降级：只调用一次、need_input、档案 sessionId 保留', async () => {
    createClaudeSessionFile('sess-wu1');
    const wu = await setupWorkUnit({ sessionId: 'sess-wu1', sessionCount: 1 });
    mockExecuteLightweight.mockRejectedValue(new Error('spawn claude ENOENT'));

    const step = await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
    expect(step.action).toBe('need_input');
    // 会话簿记不清（会话本身仍在，保留给下一步续用）
    expect(step.metadataUpdates).not.toHaveProperty('sessionId');
    expect(step.metadataUpdates).not.toHaveProperty('sessionCount');
  });

  it('#95: 续用不命中（会话文件缺）且 stepCount>0 → task.prompt 注入前序进展段', async () => {
    const wu = await setupWorkUnit({
      sessionId: 'sess-gone', sessionCount: 1, stepCount: 2,
      progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
    });

    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(lastTask().prompt).toContain('## 前序进展');
    expect(lastTask().prompt).toContain('完成数据层');
  });

  it('#95: 续用命中（会话文件在）→ task.prompt 不注入前序进展段', async () => {
    createClaudeSessionFile('sess-live');
    const wu = await setupWorkUnit({
      sessionId: 'sess-live', sessionCount: 1, stepCount: 2,
      progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
    });

    await (agentLoop as unknown as AgentStepCapable).agentStep({ workUnit: wu });

    expect(lastTask().prompt).not.toContain('## 前序进展');
  });
});
