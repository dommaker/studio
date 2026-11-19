/**
 * evolution.service tests — E1 提案决策路径（不触发频道发帖）
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { EvolutionService, EvolutionError } from '../evolution.service.js';
import { resolveEvolutionPaths } from '../signals.js';

const hoistedHome = vi.hoisted(() => {
  const fsH = require('node:fs') as typeof import('node:fs');
  const osH = require('node:os') as typeof import('node:os');
  const pathH = require('node:path') as typeof import('node:path');
  return { dir: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'evo-service-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => hoistedHome.dir };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => fs.rmSync(hoistedHome.dir, { recursive: true, force: true }));

let workDir: string;
let fileStore: FileStore;
let service: EvolutionService;

beforeEach(async () => {
  // 每个用例一个干净子目录（FileStore 数据根 = homedir()/.studio）
  workDir = path.join(hoistedHome.dir, `.studio`, 'data', 'evolution');
  fs.rmSync(workDir, { recursive: true, force: true });
  fileStore = new FileStore(path.join(hoistedHome.dir, '.studio', 'data'));
  service = new EvolutionService({
    fileStore,
    paths: resolveEvolutionPaths({
      repoRoot: hoistedHome.dir,
      studioEventsFile: path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl'),
    }),
    postCard: false,
  });
  // 造一个待审提案
  await fileStore.createEvolutionProposal({
    id: 'EP-0001',
    seq: 1,
    targetType: 'iron-law',
    targetId: 'test-constraint',
    currentText: 'old text',
    proposedText: 'new text',
    rationale: 'test',
    evidence: { failCount: 5 },
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as never);
});

afterEach(() => fs.rmSync(path.join(hoistedHome.dir, '.studio'), { recursive: true, force: true }));

describe('EvolutionService.decide', () => {
  it('reject marks the proposal rejected with metadata', async () => {
    const p = await service.decide('EP-0001', 'reject', { decidedBy: 'human', reason: '不合适' });
    expect(p.status).toBe('rejected');
    expect(p.decidedBy).toBe('human');
    expect(p.rejectReason).toBe('不合适');
  });

  it('double-decide conflicts (idempotent)', async () => {
    await service.decide('EP-0001', 'reject');
    await expect(service.decide('EP-0001', 'reject')).rejects.toThrow(EvolutionError);
    await expect(service.decide('EP-0001', 'approve')).rejects.toThrow(/already rejected/);
  });

  it('unknown id throws NOT_FOUND', async () => {
    await expect(service.decide('EP-9999', 'reject')).rejects.toThrow(/not found/);
  });

  it('decide on an expired pending marks it stale and conflicts (#602 TTL)', async () => {
    // 超期未审（TTL=14d）的 pending 不再接受决策，惰性转 stale
    await fileStore.updateEvolutionProposal('EP-0001', {
      createdAt: new Date(Date.now() - 20 * 24 * 3600_000).toISOString(),
    });
    await expect(service.decide('EP-0001', 'approve')).rejects.toThrow(/超期|stale/);
    const p = await service.get('EP-0001');
    expect(p?.status).toBe('stale');
    expect(p?.staledAt).toBeTruthy();
    await expect(service.decide('EP-0001', 'reject')).rejects.toThrow(/stale/);
  });

  it('approve 持久化目标 revision、内容 hash、观察窗口和前窗指标', async () => {
    const previous = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(hoistedHome.dir, '.studio', 'prompt-overrides');
    try {
      await fileStore.createEvolutionProposal({
        id: 'EP-0002', seq: 2, targetType: 'prompt-template', targetRepo: hoistedHome.dir,
        targetId: 'knowledge.rules-section', action: 'amend', currentText: '旧', proposedText: '新模板',
        rationale: 'test', evidence: { windowHours: 24, eventCounts: {} }, status: 'pending',
        source: 'test', createdAt: new Date().toISOString(),
      });

      const applied = await service.decide('EP-0002', 'approve', { decidedBy: 'human' });

      expect(applied.status).toBe('applied');
      expect(applied.observation).toMatchObject({
        windowHours: 24,
        beforeMetrics: { sampleCount: 0, failureCount: 0, failureRate: 0 },
      });
      expect(applied.observation?.beforeContentHash).toBeNull();
      expect(applied.observation?.afterContentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(applied.observation?.targetRevision).toBe(applied.observation?.afterContentHash);
      expect(Date.parse(applied.observation!.endsAt) - Date.parse(applied.observation!.startedAt)).toBe(24 * 3600_000);
    } finally {
      if (previous === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
      else process.env.STUDIO_PROMPT_OVERRIDES_DIR = previous;
    }
  });
});

describe('EvolutionService.settleObservations', () => {
  async function approvePrompt(outcomes: boolean[]): Promise<void> {
    await fileStore.createEvolutionProposal({
      id: 'EP-0002', seq: 2, targetType: 'prompt-template', targetRepo: hoistedHome.dir,
      targetId: 'knowledge.rules-section', action: 'amend', currentText: '旧', proposedText: '新模板',
      rationale: 'test', evidence: { windowHours: 24, eventCounts: {} }, status: 'pending',
      source: 'test', createdAt: new Date().toISOString(),
    });
    const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
    fs.writeFileSync(eventsFile, outcomes.map(success => JSON.stringify({
      type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
      payload: JSON.stringify({ success, consumedKnowledge: [] }),
      createdAt: new Date(Date.now() - 2000).toISOString(),
    })).join('\n') + '\n', 'utf-8');
    await service.decide('EP-0002', 'approve', { decidedBy: 'human' });
  }

  async function expireObservation(knowledgeEntryIds?: string[]): Promise<void> {
    const applied = await service.get('EP-0002');
    await fileStore.updateEvolutionProposal('EP-0002', {
      observation: {
        ...applied!.observation!,
        endsAt: new Date(Date.now() - 1000).toISOString(),
        ...(knowledgeEntryIds ? { knowledgeEntryIds } : {}),
      },
    });
  }

  it('观察结束指标未恶化则 keep，并保留前后指标', async () => {
    const previous = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(hoistedHome.dir, '.studio', 'prompt-overrides');
    try {
      await approvePrompt([false, false, true, true]);
      await expireObservation();
      // 观察截止后迟到的事件不得混入后窗指标。
      const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
      fs.appendFileSync(eventsFile, JSON.stringify({
        type: 'knowledge:outcome:failure',
        payload: JSON.stringify({ success: false, consumedKnowledge: [] }),
        createdAt: new Date().toISOString(),
      }) + '\n', 'utf-8');

      const result = await service.settleObservations();

      expect(result).toEqual({ kept: ['EP-0002'], rolledBack: [] });
      const decided = await service.get('EP-0002');
      expect(decided?.observation).toMatchObject({
        decision: 'keep',
        beforeMetrics: { sampleCount: 4, failureCount: 2, failureRate: 0.5 },
        afterMetrics: { sampleCount: 4, failureCount: 2, failureRate: 0.5 },
      });
      expect(fs.readFileSync(decided!.observation!.targetPath, 'utf-8')).toBe('新模板');
    } finally {
      if (previous === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
      else process.env.STUDIO_PROMPT_OVERRIDES_DIR = previous;
    }
  });

  it('指标恶化则 rollback，恢复原内容并归档关联知识', async () => {
    const previous = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(hoistedHome.dir, '.studio', 'prompt-overrides');
    const knowledgeStore = {
      get: vi.fn(() => ({ id: 'knowledge-1', maturity: 'verified', tags: [] })),
      update: vi.fn(),
    };
    service = new EvolutionService({
      fileStore,
      paths: resolveEvolutionPaths({
        repoRoot: hoistedHome.dir,
        studioEventsFile: path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl'),
      }),
      postCard: false,
      knowledgeStore,
    });
    try {
      await approvePrompt([false, true, true, true]);
      await expireObservation(['knowledge-1']);
      const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
      fs.writeFileSync(eventsFile, [false, false, false, true].map(success => JSON.stringify({
        type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
        payload: JSON.stringify({ success, consumedKnowledge: [] }),
        createdAt: new Date(Date.now() - 2000).toISOString(),
      })).join('\n') + '\n', 'utf-8');

      const result = await service.settleObservations();

      expect(result).toEqual({ kept: [], rolledBack: ['EP-0002'] });
      const decided = await service.get('EP-0002');
      expect(decided?.observation).toMatchObject({
        decision: 'rollback',
        beforeMetrics: { sampleCount: 4, failureCount: 1, failureRate: 0.25 },
        afterMetrics: { sampleCount: 4, failureCount: 3, failureRate: 0.75 },
      });
      expect(decided?.observation?.restoredAt).toBeTruthy();
      expect(fs.existsSync(decided!.observation!.targetPath)).toBe(false);
      expect(knowledgeStore.update).toHaveBeenCalledWith('knowledge-1', expect.objectContaining({ maturity: 'archived' }));
    } finally {
      if (previous === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
      else process.env.STUDIO_PROMPT_OVERRIDES_DIR = previous;
    }
  });

  it('约束退役后按整体执行结果评估，避免自身 trace 消失造成假 keep', async () => {
    await fileStore.createEvolutionProposal({
      id: 'EP-0002', seq: 2, targetType: 'guideline', targetRepo: hoistedHome.dir,
      targetId: 'governance_presence', constraintChange: 'retire', action: 'amend',
      currentText: '旧', proposedText: '退役', rationale: 'test',
      evidence: { windowHours: 24, eventCounts: {} }, status: 'applied', source: 'test',
      createdAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
      observation: {
        targetPath: path.join(hoistedHome.dir, '.harness', 'config.yml'), backupPath: null,
        targetRevision: 'rev-1', beforeContentHash: null, afterContentHash: 'not-present',
        startedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
        endsAt: new Date(Date.now() - 1000).toISOString(), windowHours: 24,
        beforeMetrics: { sampleCount: 4, failureCount: 1, failureRate: 0.25 },
      },
    });
    const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
    fs.writeFileSync(eventsFile, [false, false, false, true].map(success => JSON.stringify({
      type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
      payload: JSON.stringify({ success, consumedKnowledge: [] }),
      createdAt: new Date(Date.now() - 2000).toISOString(),
    })).join('\n') + '\n', 'utf-8');

    const result = await service.settleObservations();

    expect(result).toEqual({ kept: [], rolledBack: ['EP-0002'] });
    expect((await service.get('EP-0002'))?.observation?.afterMetrics)
      .toEqual({ sampleCount: 4, failureCount: 3, failureRate: 0.75 });
  });

  it('第三方改动阻止覆盖时仍记录 rollback 失败，不中断结算', async () => {
    const previous = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(hoistedHome.dir, '.studio', 'prompt-overrides');
    try {
      await approvePrompt([false, true]);
      await expireObservation();
      const applied = await service.get('EP-0002');
      fs.writeFileSync(applied!.observation!.targetPath, '人工后续改动', 'utf-8');
      const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
      fs.writeFileSync(eventsFile, [false, false, true].map(success => JSON.stringify({
        type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
        payload: JSON.stringify({ success, consumedKnowledge: [] }),
        createdAt: new Date(Date.now() - 2000).toISOString(),
      })).join('\n') + '\n', 'utf-8');

      const result = await service.settleObservations();

      expect(result).toEqual({ kept: [], rolledBack: ['EP-0002'] });
      const decided = await service.get('EP-0002');
      expect(decided?.observation?.decision).toBe('rollback');
      expect(decided?.observation?.rollbackError).toContain('target changed');
      expect(fs.readFileSync(decided!.observation!.targetPath, 'utf-8')).toBe('人工后续改动');
    } finally {
      if (previous === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
      else process.env.STUDIO_PROMPT_OVERRIDES_DIR = previous;
    }
  });
});

describe('EvolutionService.runScan', () => {
  it('requires an explicitly selected target repository', async () => {
    await expect((service.runScan as () => Promise<unknown>)()).rejects.toThrow(/repoRoot|target repository/);
  });

  it('角色扫描只在调用方显式点名时把既有 AgentProfile 写入待审目标', async () => {
    fs.mkdirSync(path.join(hoistedHome.dir, '.agents', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(hoistedHome.dir, '.agents', 'roles', 'developer.yaml'), 'id: developer\npersona: 旧角色\n', 'utf-8');
    const eventsFile = path.join(hoistedHome.dir, '.studio', 'data', 'test-events.jsonl');
    const calls = [
      ...Array.from({ length: 5 }, () => false),
      ...Array.from({ length: 2 }, () => true),
    ];
    fs.writeFileSync(eventsFile, calls.map(success => JSON.stringify({
      type: 'tool:call', timestamp: Date.now(), caller: 'developer', tool: 'bash', success,
    })).join('\n') + '\n', 'utf-8');

    const result = await service.runScan(hoistedHome.dir, {
      roleProfileTargets: { developer: ['profile-1'] },
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      targetType: 'role-preset', targetRepo: hoistedHome.dir, targetProfileIds: ['profile-1'],
    });
  });
});

describe('EvolutionService.list/get', () => {
  it('lists by status and gets by id', async () => {
    expect(await service.list({ status: 'pending' })).toHaveLength(1);
    expect(await service.list({ status: 'applied' })).toHaveLength(0);
    expect((await service.get('EP-0001'))?.targetId).toBe('test-constraint');
    expect(await service.get('EP-0002')).toBeNull();
  });
});
