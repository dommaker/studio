/**
 * completion-extraction (#99) — WU 收尾批量提取钩子单测
 *
 * 覆盖（对应 #99 AC + 设计要点）：
 *   AC1: WU done → 触发提取，产出写入角色记忆草稿区（appendDraft）
 *   AC2: 提取输入来自归档器 transcript（readTranscript 拼接 rawOutput），非逐步埋点
 *   AC3: 提取失败可观测（knowledge:extraction 事件）+ 不阻塞收尾（不抛）
 *   - 去重：memoryExtractedAt 哨兵，重复 done 事件不重复提取
 *   - roleId 取不到 → 跳过（no-role-id 事件）
 *   - 熔断：每日 token 预算超限 → 跳过（budget-exhausted 事件），不落哨兵可重试
 *   - 非 done 状态 → 忽略
 *
 * mock getSystemExecutor（真实 LLM 不可测）；readTranscript/appendTranscriptStep 与
 * roleMemoryStore 走真实实现（测试环境隔离目录）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../../workunit/workunit.service.js';
import { appendTranscriptStep } from '../../transcripts/transcript-archive.js';
import { roleMemoryStore } from '../role-memory.js';
import { resetDailyTokenBudgetState } from '../../agents/loop/daily-token-budget.js';

const { mockRun, mockPostCard } = vi.hoisted(() => ({ mockRun: vi.fn(), mockPostCard: vi.fn() }));

vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: () => ({ run: mockRun }),
  StudioRoleNotConfiguredError: class StudioRoleNotConfiguredError extends Error {
    constructor() {
      super('studio role provider not configured; open UI to configure');
      this.name = 'StudioRoleNotConfiguredError';
    }
  },
}));

// #101 两档路由：manual 档发卡经 postMemoryProposalCard（发卡逻辑单测在 memory-proposal-card.test.ts）
vi.mock('../memory-proposal-card.js', () => ({
  postMemoryProposalCard: mockPostCard,
}));

import { WuCompletionExtractor, buildTranscriptText, normalizeDraftInput, MEMORY_EXTRACTION_SYSTEM_PROMPT } from '../completion-extraction.js';

const ROLE_MEMORY_TEST_ROOT = path.join(os.tmpdir(), 'studio-test-role-memory');
const TRANSCRIPTS_TEST_DIR = path.join(os.tmpdir(), 'studio-test-transcripts');

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let eventsFile: string;
let extractor: WuCompletionExtractor;
// 外科式清理清单（不 rm 共享根目录，避免与 role-memory/transcript-archive 姊妹测试并发互删）
let createdRoleIds: string[] = [];
let createdWuIds: string[] = [];

/** 轮询等待异步事件处理落定（同 analysis-handoff 姊妹测试） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

/** 手工发 status_changed（快照状态与 payload 一致，同 analysis-handoff） */
function emitStatus(wu: WorkUnitData, status: string): void {
  eventBus.publish('workunit.status_changed', { workunit: { ...wu, status } });
}

async function readExtractionEvents(): Promise<Array<Record<string, unknown>>> {
  const rows = await fileStore.readJsonl<Record<string, unknown>>(eventsFile);
  return rows.filter(r => r.type === 'knowledge:extraction');
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetDailyTokenBudgetState();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  delete process.env.STUDIO_EVENTS_JSONL;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-extraction-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
  extractor = new WuCompletionExtractor(fileStore, wuService, eventsFile);
  extractor.subscribeToEvents();
  createdRoleIds = [];
  createdWuIds = [];
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  resetDailyTokenBudgetState();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  delete process.env.STUDIO_EVENTS_JSONL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 只清理本文件写入的角色目录 / transcript 文件，不动共享根目录
  for (const rid of createdRoleIds) {
    fs.rmSync(path.join(ROLE_MEMORY_TEST_ROOT, rid), { recursive: true, force: true });
  }
  for (const wid of createdWuIds) {
    fs.rmSync(path.join(TRANSCRIPTS_TEST_DIR, `${wid}.jsonl`), { force: true });
  }
});

async function createProfile(roleId: string): Promise<void> {
  createdRoleIds.push(roleId);
  await fileStore.createProfile({
    id: roleId,
    name: `role-${roleId}`,
    description: null,
    channels: '[]',
    status: 'active',
    provider: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function createDoneWu(roleId: string): Promise<WorkUnitData> {
  const wu = await wuService.create({
    type: 'task',
    scope: '实现登录功能',
    status: 'active',
    assigneeId: roleId, // profile id 直通形态（未认领指名）
  });
  createdWuIds.push(wu.id);
  return wu;
}

describe('buildTranscriptText / normalizeDraftInput（纯函数）', () => {
  it('rawOutput 逐行拼接（step/action 标注），非逐步埋点', () => {
    const text = buildTranscriptText([
      { workUnitId: 'wu-1', step: 1, action: 'progress', rawOutput: 'thinking a', createdAt: 'x' },
      { workUnitId: 'wu-1', step: 2, action: 'complete', rawOutput: 'DONE b', createdAt: 'x' },
      { workUnitId: 'wu-1', step: 3, rawOutput: '   ', createdAt: 'x' }, // 空 rawOutput 跳过
    ]);
    expect(text).toContain('[step 1/progress] thinking a');
    expect(text).toContain('[step 2/complete] DONE b');
    expect(text).not.toContain('step 3');
  });

  it('normalizeDraftInput：kind 白名单外回落 execution-knowledge；review 白名单外回落 manual；缺 title/content 返回 null', () => {
    expect(normalizeDraftInput({ kind: 'preference', title: ' 用空格 ', content: ' body ', topicSlug: ' code-style ', review: 'manual' }))
      .toEqual({ kind: 'preference', title: '用空格', content: 'body', topicSlug: 'code-style', review: 'manual' });
    expect(normalizeDraftInput({ kind: 'weird', title: 't', content: 'c', review: 'auto' }))
      .toEqual({ kind: 'execution-knowledge', title: 't', content: 'c', review: 'auto' });
    expect(normalizeDraftInput({ kind: 'execution-knowledge', title: 't', content: 'c' }))
      .toEqual({ kind: 'execution-knowledge', title: 't', content: 'c', review: 'manual' });
    expect(normalizeDraftInput({ title: 't', content: 'c', review: 'bogus' }))
      .toEqual({ kind: 'execution-knowledge', title: 't', content: 'c', review: 'manual' });
    expect(normalizeDraftInput({ title: '', content: 'c' })).toBeNull();
    expect(normalizeDraftInput({ title: 't', content: '' })).toBeNull();
  });
});

describe('WuCompletionExtractor（#99 AC）', () => {
  it('AC1: done → 触发提取，LLM 产出写入角色记忆草稿区 + 落 memoryExtractedAt 哨兵', async () => {
    const roleId = `role-${Date.now()}-a`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'REAL-TRANSCRIPT-RAW' });

    mockRun.mockResolvedValue({
      output: JSON.stringify({
        entries: [
          { kind: 'execution-knowledge', title: '登录 OAuth 坑', content: '根因+责任+预防' },
        ],
      }),
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => (await roleMemoryStore.readDraft(roleId)).length === 1);
    expect(ok).toBe(true);

    const drafts = await roleMemoryStore.readDraft(roleId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      roleId,
      kind: 'execution-knowledge',
      title: '登录 OAuth 坑',
      content: '根因+责任+预防',
    });

    // 哨兵落档（fire-and-forget 前落，防重复触发）
    const fresh = await wuService.getById(wu.id);
    expect(JSON.parse(fresh!.metadata!).memoryExtractedAt).toBeTruthy();
  });

  it('AC2: 提取输入来自归档器 transcript（readTranscript 全文），LLM 收到拼接 rawOutput', async () => {
    const roleId = `role-${Date.now()}-b`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'FROM-ARCHIVE-STEP-1' });
    await appendTranscriptStep({ workUnitId: wu.id, step: 2, action: 'complete', rawOutput: 'FROM-ARCHIVE-STEP-2' });

    mockRun.mockResolvedValue({ output: JSON.stringify({ entries: [] }), usage: undefined });

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => mockRun.mock.calls.length === 1);
    expect(ok).toBe(true);

    const transcript = mockRun.mock.calls[0][0] as string;
    expect(transcript).toContain('FROM-ARCHIVE-STEP-1');
    expect(transcript).toContain('FROM-ARCHIVE-STEP-2');
    expect(mockRun.mock.calls[0][1]).toMatchObject({ systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT });
  });

  it('AC3: 提取失败不抛（不阻塞收尾），落 failed 事件可观测', async () => {
    const roleId = `role-${Date.now()}-c`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'SOME-OUTPUT' });

    mockRun.mockRejectedValueOnce(new Error('LLM down'));

    emitStatus(wu, 'done');
    // 事件订阅链不因提取失败而抛：等 failed 事件落盘
    const ok = await waitFor(async () => {
      const events = await readExtractionEvents();
      return events.some(e => {
        const p = JSON.parse(String(e.payload));
        return p.outcome === 'failed' && p.reason === 'LLM down';
      });
    });
    expect(ok).toBe(true);

    // 哨兵已落（失败也不重复触发）；草稿未写
    const fresh = await wuService.getById(wu.id);
    expect(JSON.parse(fresh!.metadata!).memoryExtractedAt).toBeTruthy();
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
  });

  it('去重：memoryExtractedAt 哨兵已存在 → 不重复提取', async () => {
    const roleId = `role-${Date.now()}-d`;
    await createProfile(roleId);
    const wu = await wuService.create({
      type: 'task', scope: 's', status: 'active', assigneeId: roleId,
      metadata: { memoryExtractedAt: new Date().toISOString() },
    });
    createdWuIds.push(wu.id);

    emitStatus(wu, 'done');
    await new Promise(r => setTimeout(r, 100));
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('roleId 取不到（assigneeId 空）→ 跳过，落 no-role-id 事件，不落哨兵', async () => {
    const wu = await wuService.create({ type: 'task', scope: 's', status: 'active', assigneeId: null });
    createdWuIds.push(wu.id);

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => {
      const events = await readExtractionEvents();
      return events.some(e => JSON.parse(String(e.payload)).reason === 'no-role-id');
    });
    expect(ok).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();

    const fresh = await wuService.getById(wu.id);
    expect(JSON.parse(fresh!.metadata ?? '{}').memoryExtractedAt).toBeUndefined();
  });

  it('熔断：每日 token 预算超限 → 跳过，落 budget-exhausted 事件，不落哨兵', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '1000';
    // 当日已耗 2000（billed 口径）→ 超限
    await fileStore.appendJsonl(eventsFile, {
      type: 'workunit:tokens',
      payload: JSON.stringify({ billedTokens: 2000 }),
      createdAt: new Date().toISOString(),
    });

    const roleId = `role-${Date.now()}-e`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => {
      const events = await readExtractionEvents();
      return events.some(e => JSON.parse(String(e.payload)).reason === 'budget-exhausted');
    });
    expect(ok).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();

    const fresh = await wuService.getById(wu.id);
    expect(JSON.parse(fresh!.metadata ?? '{}').memoryExtractedAt).toBeUndefined();
  });

  it('非 done 状态 → 忽略，不触发', async () => {
    const roleId = `role-${Date.now()}-f`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);

    emitStatus(wu, 'in_review');
    await new Promise(r => setTimeout(r, 100));
    expect(mockRun).not.toHaveBeenCalled();
    expect(await readExtractionEvents()).toHaveLength(0);
  });
});

describe('两档路由（#101：auto→promote / manual→卡）', () => {
  it('AC1-2: auto 条目直接 promote 进索引，不产卡', async () => {
    const roleId = `role-${Date.now()}-g`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'AUTO-RAW' });

    mockRun.mockResolvedValue({
      output: JSON.stringify({
        entries: [{ kind: 'execution-knowledge', title: 'Testing Command', content: 'pnpm test:api', review: 'auto' }],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => (await roleMemoryStore.readIndex(roleId)).includes('testing-command'));
    expect(ok).toBe(true);

    // 自动进索引：topic + 索引已写，草稿无 pending，不发卡
    const topic = await roleMemoryStore.readTopic(roleId, 'testing-command');
    expect(topic?.body).toContain('pnpm test:api');
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(0);
    expect(mockPostCard).not.toHaveBeenCalled();
  });

  it('AC2-1: manual 条目发 memory_proposal 卡（不自动 promote），草稿留 pending', async () => {
    const roleId = `role-${Date.now()}-h`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'MANUAL-RAW' });

    mockRun.mockResolvedValue({
      output: JSON.stringify({
        entries: [{ kind: 'preference', title: '命名约定', content: '分支名 feat/<n>-<slug>', review: 'manual' }],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => mockPostCard.mock.calls.length === 1);
    expect(ok).toBe(true);

    // 发卡（不自动进索引）；草稿仍 pending 待 approve
    const [entries, ctx] = mockPostCard.mock.calls[0];
    expect(entries).toHaveLength(1);
    expect(entries[0].review).toBe('manual');
    expect(ctx.workUnitId).toBe(wu.id);
    expect(await roleMemoryStore.readIndex(roleId)).toBe('');
    expect(await roleMemoryStore.readDraft(roleId)).toHaveLength(1);
  });

  it('混合：auto 直接进索引 + manual 发卡', async () => {
    const roleId = `role-${Date.now()}-i`;
    await createProfile(roleId);
    const wu = await createDoneWu(roleId);
    await appendTranscriptStep({ workUnitId: wu.id, step: 1, action: 'progress', rawOutput: 'MIX-RAW' });

    mockRun.mockResolvedValue({
      output: JSON.stringify({
        entries: [
          { kind: 'execution-knowledge', title: 'Auto Fact', content: 'auto-content', review: 'auto' },
          { kind: 'execution-knowledge', title: 'Manual Lesson', content: 'manual-content', review: 'manual' },
        ],
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    emitStatus(wu, 'done');
    const ok = await waitFor(async () => mockPostCard.mock.calls.length === 1);
    expect(ok).toBe(true);

    const index = await roleMemoryStore.readIndex(roleId);
    expect(index).toContain('auto-fact');
    expect(index).not.toContain('manual-lesson');
    const manualEntries = mockPostCard.mock.calls[0][0];
    expect(manualEntries).toHaveLength(1);
    expect(manualEntries[0].title).toBe('Manual Lesson');
  });
});
