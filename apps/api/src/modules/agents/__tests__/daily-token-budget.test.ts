// 2026-08-03 unattended-token-burn issue — C3 每日 token 预算熔断测试
// 纯函数（开关/预算/扫描/计数/告警留痕）+ agentStep 熔断集成。
// mock 约定与 token-burn-guards.test.ts 一致：execSync + agentRunner.executeLightweight +
// knowledge-service + trigger-registry；WorkUnitService 用真实实现（tmpdir FileStore）。
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

import { AgentLoop, writeWorkunitTokenEvent, type StepResult } from '../loop/agent-loop';
import {
  BUDGET_TRIPPED_EVENT,
  DEFAULT_DAILY_TOKEN_BUDGET,
  getDailyTokenUsage,
  noteTokensWritten,
  notifyBudgetTripped,
  resetDailyTokenBudgetState,
  resolveDailyTokenBudget,
  tokenBudgetGuardEnabled,
} from '../loop/daily-token-budget';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service';

const mockRole = {
  id: 'role-budget',
  name: 'budget-test-agent',
  description: 'daily budget guard test agent',
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

const prevGuardEnv = process.env.STUDIO_TOKEN_BUDGET_GUARD;
const prevBudgetEnv = process.env.STUDIO_DAILY_TOKEN_BUDGET;
const prevEventsJsonl = process.env.STUDIO_EVENTS_JSONL;

/** 建一个 runLoop 不会碰的 WU：status=active + assigneeId 指向别的实例 */
async function createActiveWu(metadata: WorkUnitMetadata = {}, scope = '预算测试任务'): Promise<WorkUnitData> {
  const wu = await wuService.create({
    scope, type: 'task', channelId: null, status: 'active', assigneeId: 'other-instance', metadata,
  });
  return (await wuService.getById(wu.id))!;
}

function metaOf(wu: { metadata: string | null }): WorkUnitMetadata {
  return wu.metadata ? JSON.parse(wu.metadata) : {};
}

/** 直接往事件文件追加一行（构造历史用量/留痕用） */
function appendEvent(file: string, row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf-8');
}

function tokenEventRow(tokens: { billed?: number; total?: number }, createdAt: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { workUnitId: 'wu-x', injectedTokens: 100 };
  if (tokens.billed !== undefined) payload.billedTokens = tokens.billed;
  if (tokens.total !== undefined) payload.totalTokens = tokens.total;
  return { type: 'workunit:tokens', source: 'test', payload: JSON.stringify(payload), createdAt };
}

function readRows(file: string): Array<{ type?: string; payload?: string }> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { type?: string; payload?: string });
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
  resetDailyTokenBudgetState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-token-budget-'));
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
  await Promise.race([
    agentLoop.waitForStop(),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  resetDailyTokenBudgetState();
  if (prevGuardEnv === undefined) delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  else process.env.STUDIO_TOKEN_BUDGET_GUARD = prevGuardEnv;
  if (prevBudgetEnv === undefined) delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  else process.env.STUDIO_DAILY_TOKEN_BUDGET = prevBudgetEnv;
  if (prevEventsJsonl === undefined) delete process.env.STUDIO_EVENTS_JSONL;
  else process.env.STUDIO_EVENTS_JSONL = prevEventsJsonl;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 5000);

// ── 开关与预算解析 ──

describe('C3: tokenBudgetGuardEnabled / resolveDailyTokenBudget', () => {
  it('测试环境默认关闭，生产默认开启，on/off 显式覆盖', () => {
    expect(tokenBudgetGuardEnabled({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(tokenBudgetGuardEnabled({ VITEST: 'true', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(tokenBudgetGuardEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(tokenBudgetGuardEnabled({ NODE_ENV: 'test', STUDIO_TOKEN_BUDGET_GUARD: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(tokenBudgetGuardEnabled({ NODE_ENV: 'production', STUDIO_TOKEN_BUDGET_GUARD: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('预算默认 2M；env 覆盖；非法值回落默认；<=0 表示不熔断', () => {
    expect(resolveDailyTokenBudget({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
    expect(resolveDailyTokenBudget({ STUDIO_DAILY_TOKEN_BUDGET: '5000' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(resolveDailyTokenBudget({ STUDIO_DAILY_TOKEN_BUDGET: 'abc' } as NodeJS.ProcessEnv)).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
    expect(resolveDailyTokenBudget({ STUDIO_DAILY_TOKEN_BUDGET: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveDailyTokenBudget({ STUDIO_DAILY_TOKEN_BUDGET: '-100' } as NodeJS.ProcessEnv)).toBe(-100);
  });
});

// ── 当日用量扫描（bootstrap）与进程内计数器 ──

describe('C3: getDailyTokenUsage 扫描口径', () => {
  const todayIso = () => new Date().toISOString();
  const yesterdayIso = () => new Date(Date.now() - 86_400_000).toISOString();

  it('空文件/不存在 → 全零，不抛错', async () => {
    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.usedTokens).toBe(0);
    expect(usage.notified).toBe(false);
  });

  it('billed 优先、无 billed 退回 total；仅计当日', async () => {
    appendEvent(eventsFile, tokenEventRow({ billed: 1000, total: 1100 }, todayIso())); // 取 billed
    appendEvent(eventsFile, tokenEventRow({ total: 500 }, todayIso())); // 旧事件退回 total
    appendEvent(eventsFile, tokenEventRow({ billed: 999_999 }, yesterdayIso())); // 昨日不计
    appendEvent(eventsFile, { type: 'monitor:alert', payload: '{}', createdAt: todayIso() }); // 无关类型
    appendEvent(eventsFile, { type: 'workunit:tokens', payload: '{broken', createdAt: todayIso() }); // 损坏行跳过

    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.usedTokens).toBe(1500);
    expect(usage.notified).toBe(false);
  });

  it('当日已有 budget-tripped 留痕 → notified=true（重启不重复告警）', async () => {
    appendEvent(eventsFile, {
      type: BUDGET_TRIPPED_EVENT,
      payload: JSON.stringify({ dateKey: 'x', usedTokens: 1, budget: 1 }),
      createdAt: todayIso(),
    });

    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.notified).toBe(true);
  });

  it('noteTokensWritten 在 bootstrap 后累加；跨天/换文件不计', async () => {
    appendEvent(eventsFile, tokenEventRow({ billed: 100 }, todayIso()));
    await getDailyTokenUsage({ eventsFile });

    noteTokensWritten(eventsFile, 50);
    noteTokensWritten(eventsFile, -1); // 非正数忽略
    noteTokensWritten(path.join(tmpDir, 'other.jsonl'), 999); // 其他文件忽略

    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.usedTokens).toBe(150);
  });

  it('writeWorkunitTokenEvent 落盘后计数器同步累加（billed ?? injected+execution）', async () => {
    await getDailyTokenUsage({ eventsFile }); // bootstrap
    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-a', executionId: 'e-1', injectedTokens: 100, executionTokens: 60, billedTokens: 900,
    });
    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-b', executionId: 'e-2', injectedTokens: 100, executionTokens: 60,
    });
    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.usedTokens).toBe(900 + 160); // billed 900；无 billed 退回 total=100+60
  });
});

// ── 熔断告警留痕 ──

describe('C3: notifyBudgetTripped', () => {
  it('落 budget-tripped 事件 + 状态置 notified（重扫后仍 notified）', async () => {
    await getDailyTokenUsage({ eventsFile }); // bootstrap
    await notifyBudgetTripped({ eventsFile, usedTokens: 2_500_000, budget: 2_000_000 });

    const rows = readRows(eventsFile);
    const tripped = rows.filter(r => r.type === BUDGET_TRIPPED_EVENT);
    expect(tripped).toHaveLength(1);
    const payload = JSON.parse(tripped[0].payload!);
    expect(payload.usedTokens).toBe(2_500_000);
    expect(payload.budget).toBe(2_000_000);

    // 模拟重启：清空进程内状态重扫 → notified 从留痕恢复
    resetDailyTokenBudgetState();
    const usage = await getDailyTokenUsage({ eventsFile });
    expect(usage.notified).toBe(true);
  });
});

// ── agentStep 熔断集成 ──

describe('C3: agentStep 预算熔断（STUDIO_TOKEN_BUDGET_GUARD=on）', () => {
  it('当日已耗 ≥ 预算：不起会话、need_input 挂起 + blockReason，当日只告警一次', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '1000';
    appendEvent(eventsFile, tokenEventRow({ billed: 1500 }, new Date().toISOString()));

    const wu1 = await createActiveWu({}, '正常任务一');
    const result1 = await stepOf(agentLoop)({ workUnit: wu1 });

    expect(result1.action).toBe('need_input');
    expect(result1.summary).toContain('预算已熔断');
    expect(mockExecuteLightweight).not.toHaveBeenCalled();

    // recordResult 落盘：blocked + 挂起标记 + blockReason（B4 链路复用）
    await recordOf(agentLoop)({ workUnit: wu1 }, result1);
    const after = (await wuService.getById(wu1.id))!;
    expect(after.status).toBe('blocked');
    const meta = metaOf(after);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.blockReason).toContain('need-input');
    expect(meta.blockReason).toContain('预算已熔断');

    // 第二个 WU 同样被熔断，但当日不再重复告警（budget-tripped 事件仍只有一条）
    const wu2 = await createActiveWu({}, '正常任务二');
    const result2 = await stepOf(agentLoop)({ workUnit: wu2 });
    expect(result2.action).toBe('need_input');
    const trippedRows = readRows(eventsFile).filter(r => r.type === BUDGET_TRIPPED_EVENT);
    expect(trippedRows).toHaveLength(1);
  });

  it('当日已耗 < 预算：正常执行', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '100000';
    appendEvent(eventsFile, tokenEventRow({ billed: 1500 }, new Date().toISOString()));
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const wu = await createActiveWu({}, '正常任务');
    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
  });

  it('预算 <=0：关闭熔断，已耗再高也照常执行', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '0';
    appendEvent(eventsFile, tokenEventRow({ billed: 999_999_999 }, new Date().toISOString()));
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    const wu = await createActiveWu({}, '正常任务');
    const result = await stepOf(agentLoop)({ workUnit: wu });

    expect(result.action).toBe('progress');
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1);
  });

  it('执行记账推高当日用量 → 后续 step 触发熔断（计数器链路闭环）', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '1000';
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheCreationTokens: 20, model: 'm' },
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });

    // 第一 step：执行成功（billed=970），记账后当日用量 970 < 1000
    const wu1 = await createActiveWu({}, '正常任务一');
    const first = await stepOf(agentLoop)({ workUnit: wu1 });
    expect(first.action).toBe('progress');
    await new Promise(r => setTimeout(r, 50)); // token 事件 fire-and-forget，等落盘 + 计数器累加

    // 第二 step：970 + 本步将烧 >0 → 已耗虽未达 1000……再补一条历史事件越过阈值
    appendEvent(eventsFile, tokenEventRow({ billed: 100 }, new Date().toISOString()));
    resetDailyTokenBudgetState(); // 强制重扫（等价跨进程视角：文件已含 970 + 100）
    const wu2 = await createActiveWu({}, '正常任务二');
    const second = await stepOf(agentLoop)({ workUnit: wu2 });

    expect(second.action).toBe('need_input');
    expect(second.summary).toContain('预算已熔断');
    expect(mockExecuteLightweight).toHaveBeenCalledTimes(1); // 仅第一 step 起了会话
  });
});
