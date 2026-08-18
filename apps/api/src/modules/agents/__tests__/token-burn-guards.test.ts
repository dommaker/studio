// 2026-08-03 unattended-token-burn issue — B 档守卫测试
// B2 测试特征 WU 守卫 / B4 blockReason / B5 会话数上限 / B6 真实 token 记账
// mock 约定与 agent-loop.test.ts 一致：execSync（健康探测）+ agentRunner.executeLightweight +
// knowledge-service + trigger-registry；WorkUnitService 用真实实现（tmpdir FileStore）以便断言落盘。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileStore } from '@dommaker/studio-shared';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
}));
vi.mock('child_process', () => ({ execSync: mockExecSync }));

const { mockExecuteLightweight } = vi.hoisted(() => ({ mockExecuteLightweight: vi.fn() }));
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { mockTriggerScheduler } = vi.hoisted(() => ({
  mockTriggerScheduler: {
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    getStates: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../../triggers/trigger-registry', () => ({ getTriggerScheduler: () => mockTriggerScheduler }));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  AgentLoop,
  isTestLikeWorkUnit,
  testWuGuardEnabled,
  resolveRealUsage,
  writeWorkunitTokenEvent,
  type StepResult,
} from '../loop/agent-loop';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service';
import type { ExecutionResult } from '@dommaker/studio-agent';

const mockRole = {
  id: 'role-guard',
  name: 'guard-test-agent',
  description: 'token-burn guard test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as ConstructorParameters<typeof AgentLoop>[0];

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let agentLoop: AgentLoop;
let eventsFile: string;

const prevGuardEnv = process.env.STUDIO_TEST_WU_GUARD;
const prevEventsJsonl = process.env.STUDIO_EVENTS_JSONL;

/** 建一个 runLoop 不会碰的 WU：status=active + assigneeId 指向别的实例 */
async function createActiveWu(metadata: WorkUnitMetadata = {}, scope = '守卫测试任务'): Promise<WorkUnitData> {
  const wu = await wuService.create({
    scope, type: 'task', channelId: null, status: 'active', assigneeId: 'other-instance', metadata,
  });
  return (await wuService.getById(wu.id))!;
}

function metaOf(wu: { metadata: string | null }): WorkUnitMetadata {
  return wu.metadata ? JSON.parse(wu.metadata) : {};
}

/** 读事件文件并取首个 workunit:tokens 行的 payload（同文件还混有 knowledge:skill_used 等行） */
function readTokenEventPayload(): Record<string, unknown> {
  const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line) as { type?: string; payload?: string };
    if (row.type === 'workunit:tokens') return JSON.parse(row.payload!) as Record<string, unknown>;
  }
  throw new Error('no workunit:tokens row found');
}

type AgentStepFn = (t: { workUnit: WorkUnitData }) => Promise<StepResult>;
type RecordResultFn = (t: { workUnit: WorkUnitData }, r: StepResult) => Promise<void>;
const stepOf = (loop: AgentLoop): AgentStepFn =>
  (loop as unknown as { agentStep: AgentStepFn }).agentStep.bind(loop);
const recordOf = (loop: AgentLoop): RecordResultFn =>
  (loop as unknown as { recordResult: RecordResultFn }).recordResult.bind(loop);

beforeEach(async () => {
  vi.clearAllMocks();
  mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-burn-guards-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_JSONL = eventsFile;
  agentLoop = new AgentLoop(mockRole, fileStore);
  await agentLoop.start();
});

afterEach(async () => {
  agentLoop.stop();
  // runLoop 内部有 sleep(15_000)，waitForStop 可能等满一个周期 —— 2s 赛跑超时直接放行
  // （runLoop 后台退出，与 agent-loop.test.ts 既有约定一致）
  await Promise.race([
    agentLoop.waitForStop(),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (prevGuardEnv === undefined) delete process.env.STUDIO_TEST_WU_GUARD;
  else process.env.STUDIO_TEST_WU_GUARD = prevGuardEnv;
  if (prevEventsJsonl === undefined) delete process.env.STUDIO_EVENTS_JSONL;
  else process.env.STUDIO_EVENTS_JSONL = prevEventsJsonl;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 5000);

// ── B2: 测试特征 WU 守卫 ──

describe('B2: isTestLikeWorkUnit / testWuGuardEnabled', () => {
  it('scope 命中独立 test 单词（历史污染源形态）', () => {
    expect(isTestLikeWorkUnit({ scope: 'tree-tokens test' }, {})).toBe(true);
    expect(isTestLikeWorkUnit({ scope: 'test' }, {})).toBe(true);
    expect(isTestLikeWorkUnit({ scope: 'Thread-Test' }, {})).toBe(true);
    expect(isTestLikeWorkUnit({ scope: 'load test: api' }, {})).toBe(true);
  });

  it('metadata 显式标记命中', () => {
    expect(isTestLikeWorkUnit({ scope: '正常任务' }, { test: true })).toBe(true);
    expect(isTestLikeWorkUnit({ scope: '正常任务' }, { testWorkUnit: true })).toBe(true);
  });

  it('正常 scope 不误伤（contest/latest/中文）', () => {
    expect(isTestLikeWorkUnit({ scope: 'contest results page' }, {})).toBe(false);
    expect(isTestLikeWorkUnit({ scope: 'latest news digest' }, {})).toBe(false);
    expect(isTestLikeWorkUnit({ scope: '实现登录功能' }, {})).toBe(false);
  });

  it('守卫开关：测试环境默认关闭，显式 on/off 覆盖', () => {
    expect(testWuGuardEnabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(testWuGuardEnabled({ VITEST: 'true', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(testWuGuardEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(testWuGuardEnabled({ NODE_ENV: 'test', STUDIO_TEST_WU_GUARD: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(testWuGuardEnabled({ NODE_ENV: 'production', STUDIO_TEST_WU_GUARD: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('B2: agentStep 守卫集成（STUDIO_TEST_WU_GUARD=on）', () => {
  it('测试特征 WU 不起会话、直接关闭并留痕', async () => {
    process.env.STUDIO_TEST_WU_GUARD = 'on';
    const wu = await createActiveWu({}, 'tree-tokens test');

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('skipped');
    expect(mockExecuteLightweight).not.toHaveBeenCalled();
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('closed');
    const meta = metaOf(after);
    expect(meta.testWorkUnitGuard).toBe(true);
    expect(meta.blockReason).toContain('test-wu-guard');
  });

  it('正常 WU 不受影响', async () => {
    process.env.STUDIO_TEST_WU_GUARD = 'on';
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({}, '实现登录功能');

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
  });
});

// ── B5: 每 WU 会话数上限 ──

describe('B5: 会话数上限（MAX_SESSIONS_PER_WU=5，#95 2→5）', () => {
  // #94: claude 续用判定要求会话文件存在（cwd 未知时一律按续用）——本组用例验证新建分支，
  // 统一给一个无会话文件的 workspaceRoot（无 .git 不走 worktree），使判定落入新建路径
  const noSessionRoot = (): string => path.join(tmpDir, 'wt-no-session');

  it('sessionCount 已达 5 且无续用 → need_input 转人工，不起新会话', async () => {
    const wu = await createActiveWu({ sessionCount: 5, sessionId: 'old-session', workspaceRoot: noSessionRoot() });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('need_input');
    expect(result.summary).toContain('会话重建已达上限');
    expect(mockExecuteLightweight).not.toHaveBeenCalled();

    // recordResult 落盘：blocked + 挂起标记 + B4 blockReason
    await recordOf(agentLoop)({ workUnit: wu }, result);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    const meta = metaOf(after);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.blockReason).toContain('need-input');
  });

  it('sessionCount=1 仍可再开一个会话（计数递增）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({ sessionCount: 1, sessionId: 'prev-session', workspaceRoot: noSessionRoot() });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(result.metadataUpdates!.sessionCount).toBe(2);
    expect(result.metadataUpdates!.sessionId).toBeDefined();
  });

  it('旧数据无 sessionCount：有 sessionId 按已用 1 个计', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({ sessionId: 'legacy-session', workspaceRoot: noSessionRoot() });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(result.metadataUpdates!.sessionCount).toBe(2);
  });

  it('续用同一会话不消耗新会话额度（sessionResumes 递增）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({});
    // 第一 step：建立会话（sessionCount 1）
    const first = await stepOf(agentLoop)({ workUnit: wu });
    expect(first.metadataUpdates!.sessionCount).toBe(1);
    const sessionId = first.metadataUpdates!.sessionId as string;

    // 第二 step：档案有 sessionId → 续用（#94：cwd 解析不出时 claude 无法校验会话文件，
    // 按续用处理、交给 CLI 错误 + 降级兜底；本用例 WU 无 workspaceId/workspaceRoot → cwd=null）
    const wu2 = await createActiveWu({ sessionCount: 1, sessionId });
    const second = await stepOf(agentLoop)({ workUnit: wu2 });
    expect(second.metadataUpdates!.sessionResumes).toBe(1);
    expect(second.metadataUpdates!.sessionCount).toBeUndefined();
  });

  it('新会话首 step 失败：sessionCount 计入（#95 失败尝试计入预算），sessionId 仍回滚', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI crashed',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({ sessionCount: 1, sessionId: 'prev', workspaceRoot: noSessionRoot() });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('failed');
    expect(result.metadataUpdates!.sessionCount).toBe(2);
    expect(result.metadataUpdates!.sessionId).toBeUndefined();
  });

  it('sessionCount=4 仍可再开一个会话（计数到 5 上限）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({ sessionCount: 4, sessionId: 'prev-session', workspaceRoot: noSessionRoot() });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(result.metadataUpdates!.sessionCount).toBe(5);
  });
});

// ── B4: recordResult blockReason 落盘/清除 ──

describe('B4: recordResult blockReason', () => {
  it('连续 3 步无进展 → blocked + stuck 原因', async () => {
    const wu = await createActiveWu({ consecutiveStuck: 2 });

    await recordOf(agentLoop)({ workUnit: wu }, { action: 'failed', summary: 'CLI 执行失败: boom' });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    expect(metaOf(after).blockReason).toContain('stuck');
    expect(metaOf(after).blockReason).toContain('boom');
  });

  it('恢复进展（progress）时清除陈旧 blockReason', async () => {
    const wu = await createActiveWu({ blockReason: 'stuck: 连续 3 步无进展' });

    await recordOf(agentLoop)({ workUnit: wu }, { action: 'progress', summary: '继续推进' });

    const after = (await wuService.getById(wu.id))!;
    expect(metaOf(after).blockReason).toBeUndefined();
  });

  it('skipped 结果：recordResult 完全不动簿记', async () => {
    const wu = await createActiveWu({});

    await recordOf(agentLoop)({ workUnit: wu }, { action: 'skipped', summary: '' });

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    expect(metaOf(after).stepCount).toBeUndefined();
  });
});

// ── B6: 真实 token 记账 ──

describe('B6: resolveRealUsage', () => {
  it('rawOutput 有 modelUsage 时优先（多轮累积口径，含 costUsd/numTurns）', () => {
    const rawOutput = [
      '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}',
      '{"type":"result","num_turns":7,"total_cost_usd":0.188,'
        + '"usage":{"input_tokens":11,"output_tokens":6,"cache_read_input_tokens":50,"cache_creation_input_tokens":4},'
        + '"modelUsage":{"m1":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":800,"cacheCreationInputTokens":20,"costUSD":0.188}}}',
    ].join('\n');
    const real = resolveRealUsage({ rawOutput } as unknown as ExecutionResult);
    expect(real).not.toBeNull();
    expect(real!.inputTokens).toBe(100);
    expect(real!.outputTokens).toBe(50);
    expect(real!.cacheReadTokens).toBe(800);
    expect(real!.cacheCreationTokens).toBe(20);
    expect(real!.billedTokens).toBe(970);
    expect(real!.costUsd).toBe(0.188);
    expect(real!.numTurns).toBe(7);
  });

  it('无 rawOutput 时兜底 runner 透出的 usage 聚合', () => {
    const real = resolveRealUsage({
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheCreationTokens: 20, model: 'm' },
    } as unknown as ExecutionResult);
    expect(real!.billedTokens).toBe(970);
    expect(real!.costUsd).toBeUndefined();
  });

  it('全零 / 无 usage → null（不编造）', () => {
    expect(resolveRealUsage({} as unknown as ExecutionResult)).toBeNull();
    expect(resolveRealUsage({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: '' },
    } as unknown as ExecutionResult)).toBeNull();
  });

  it('#134: opencode rawOutput 从 step_finish part.tokens 解析', () => {
    const rawOutput = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":12073,"output":2,"reasoning":0,"cache":{"write":100,"read":5000}},"cost":0.005253495}}',
    ].join('\n');
    const real = resolveRealUsage({ rawOutput } as unknown as ExecutionResult, 'opencode');
    expect(real).toEqual({
      inputTokens: 12073,
      outputTokens: 2,
      cacheReadTokens: 5000,
      cacheCreationTokens: 100,
      billedTokens: 17175,
      costUsd: 0.005253495,
    });
  });

  it('#134: codex rawOutput 从 turn.completed usage 解析（input 归一化为非缓存口径）', () => {
    const rawOutput = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":13618,"cached_input_tokens":9728,"cache_write_input_tokens":0,"output_tokens":2}}',
    ].join('\n');
    const real = resolveRealUsage({ rawOutput } as unknown as ExecutionResult, 'codex');
    expect(real).toEqual({
      inputTokens: 3890, // 13618 含 cached 9728 子集，归一化防 billed 双计
      outputTokens: 2,
      cacheReadTokens: 9728,
      cacheCreationTokens: 0,
      billedTokens: 13620,
    });
  });

  it('#134: kimi rawOutput 无 usage 出口 → null（诚实口径）', () => {
    const rawOutput = '{"role":"meta","type":"system.version","version":"0.36.1"}\n{"role":"assistant","content":"OK"}';
    expect(resolveRealUsage({ rawOutput } as unknown as ExecutionResult, 'kimi')).toBeNull();
  });

  it('#134: 缺省 provider=claude（既有行为不变）', () => {
    const rawOutput = '{"type":"result","usage":{"input_tokens":10,"output_tokens":5}}';
    expect(resolveRealUsage({ rawOutput } as unknown as ExecutionResult)!.inputTokens).toBe(10);
  });
});

describe('B6: writeWorkunitTokenEvent 载荷', () => {
  it('totalTokens 用 billed 口径（含 cache），executionTokens 保持 input+output', async () => {
    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-b6', executionId: 'e-1', injectedTokens: 600,
      executionTokens: 150, outputTokens: 50, inputTokens: 100,
      cacheReadTokens: 800, cacheCreationTokens: 20, billedTokens: 970,
      costUsd: 0.188, numTurns: 7, triggerId: 'daily-health-check',
    });
    const row = JSON.parse(fs.readFileSync(eventsFile, 'utf-8').trim());
    const payload = JSON.parse(row.payload);
    expect(payload.executionTokens).toBe(150);expect(payload.billedTokens).toBe(970);
    expect(payload.totalTokens).toBe(600 + 970);
    expect(payload.outputTokens).toBe(50);
    expect(payload.costUsd).toBe(0.188);
    expect(payload.numTurns).toBe(7);
    expect(payload.triggerId).toBe('daily-health-check');
    expect(payload.executionSource).toBe('cli-usage');
  });

  it('CLI 未回报 usage：executionSource=unavailable，totalTokens 仅计注入', async () => {
    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-b6-none', executionId: 'e-2', injectedTokens: 600, executionTokens: null,
    });
    const payload = JSON.parse(JSON.parse(fs.readFileSync(eventsFile, 'utf-8').trim()).payload);
    expect(payload.executionSource).toBe('unavailable');
    expect(payload.totalTokens).toBe(600);
    expect(payload.billedTokens).toBeUndefined();
  });

  it('#134: provider 字段落盘（#120 按 provider 分桶的数据源）', async () => {
    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-134', executionId: 'e-3', injectedTokens: 600,
      executionTokens: 12075, inputTokens: 12073, outputTokens: 2,
      billedTokens: 12075, provider: 'opencode',
    });
    const payload = JSON.parse(JSON.parse(fs.readFileSync(eventsFile, 'utf-8').trim()).payload);
    expect(payload.provider).toBe('opencode');
  });
});

describe('B6: agentStep 记账集成', () => {
  it('成功执行：事件落盘 billed 口径 + _cumulativeTokens 按 billed 累加', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      rawOutput: '{"type":"result","num_turns":3,"total_cost_usd":0.05,'
        + '"usage":{"input_tokens":10,"output_tokens":5},'
        + '"modelUsage":{"m1":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":800,"cacheCreationInputTokens":20,"costUSD":0.05}}}',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({ _cumulativeTokens: 70, triggerId: 'knowledge-quality-audit' });

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.metadataUpdates!._cumulativeTokens).toBe(70 + 970);
    await new Promise(r => setTimeout(r, 50)); // token 事件 fire-and-forget，等落盘
    const payload = readTokenEventPayload();
    expect(payload.billedTokens).toBe(970);
    expect(payload.executionTokens).toBe(150);
    expect(payload.triggerId).toBe('knowledge-quality-audit');
  });

  it('失败执行同样记账（runner error 路径透出的 usage）', async () => {
    mockExecuteLightweight.mockResolvedValue({
      success: false, error: 'CLI crashed',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 2, model: 'm' },
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const wu = await createActiveWu({});

    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('failed');
    await new Promise(r => setTimeout(r, 50)); // token 事件 fire-and-forget，等落盘
    const payload = readTokenEventPayload();
    expect(payload.billedTokens).toBe(20);
    expect(payload.executionTokens).toBe(15);
    expect(payload.executionSource).toBe('cli-usage');
  });
});
