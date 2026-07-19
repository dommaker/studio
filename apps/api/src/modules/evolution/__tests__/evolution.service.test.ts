/**
 * evolution.service tests — E1 提案决策路径（不触发频道发帖）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

let workDir: string;
let fileStore: FileStore;
let service: EvolutionService;

beforeEach(async () => {
  // 每个用例一个干净子目录（FileStore 数据根 = homedir()/.studio）
  workDir = path.join(hoistedHome.dir, `.studio`, 'data', 'evolution');
  fs.rmSync(workDir, { recursive: true, force: true });
  fileStore = new FileStore();
  service = new EvolutionService({
    fileStore,
    paths: resolveEvolutionPaths({ repoRoot: hoistedHome.dir, eventsDir: path.join(hoistedHome.dir, 'events') }),
    postToChannel: false,
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
});

describe('EvolutionService.list/get', () => {
  it('lists by status and gets by id', async () => {
    expect(await service.list({ status: 'pending' })).toHaveLength(1);
    expect(await service.list({ status: 'applied' })).toHaveLength(0);
    expect((await service.get('EP-0001'))?.targetId).toBe('test-constraint');
    expect(await service.get('EP-0002')).toBeNull();
  });
});
