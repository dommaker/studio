/**
 * #137 验收 — KnowledgeSync 零值 cycle 止血
 *
 * 全零 cycle（0 stale / 0 unmonitored / 0 healed）只写日志，不落 knowledge 条目；
 * 非零 cycle 照常落 trend 条目，行为不变。
 *
 * 夹具同 knowledge-sync-staleness.test.ts：tmp git repo + tmp FileKnowledgeStore。
 * #343：KnowledgeBus 删除，recordPattern 断言走 knowledgeService mock。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const { recordPattern } = vi.hoisted(() => ({
  recordPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../knowledge-singletons.js', async () => {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  const osMod = await import('os');
  const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ksync-cycle-store-'));

  const harness = await vi.importActual<any>('@dommaker/harness');
  const { FileKnowledgeStore, KnowledgeIngest } = harness;
  const sharedStore = new FileKnowledgeStore({ baseDir: tmpDir });

  (globalThis as any).__ksyncCycleTest = { tmpDir, sharedStore };

  return {
    UNIFIED_KNOWLEDGE_DIR: tmpDir,
    sharedStore,
    sharedIngest: new KnowledgeIngest(sharedStore),
    sharedLifecycle: { recordReference: vi.fn() },
    scheduleVectorDbSync: vi.fn(),
  };
});

// #343：KnowledgeBus 删除，recordPattern 走 knowledgeService 单一路径
vi.mock('../knowledge-design-doc.js', () => ({
  upsertKnowledge: vi.fn(),
}));
vi.mock('../knowledge-service.js', () => ({
  knowledgeService: { recordPattern },
}));

import { knowledgeSync } from '../knowledge-sync.service.js';

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

describe('#137: zero-value sync cycle does not persist a knowledge entry', () => {
  let repoDir: string;
  let storeDir: string;
  let sharedStore: any;

  beforeAll(() => {
    ({ tmpDir: storeDir, sharedStore } = (globalThis as any).__ksyncCycleTest);

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksync-cycle-repo-'));
    git(repoDir, 'init -q');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src/watched.ts'), 'export const v = 1;\n');
    git(repoDir, 'add -A');
    git(repoDir, 'commit -qm init');
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('all-zero cycle (0 stale / 0 unmonitored / 0 healed) writes no entry', async () => {
    // 空注册表 + 空知识库 → 全零 cycle
    const result = await knowledgeSync.runSyncCycle(repoDir);
    expect(result.stale).toHaveLength(0);
    expect(result.unmonitored).toHaveLength(0);
    expect(result.healed).toHaveLength(0);
    expect(recordPattern).not.toHaveBeenCalled();
  });

  it('non-zero cycle still persists a trend entry (behavior unchanged)', async () => {
    const SCOPE = 'i137-watched-scope';
    knowledgeSync.registerScope(SCOPE, {
      files: ['src/watched.ts'],
      title: 'i137 watched scope',
      knowledgeType: 'architecture',
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sharedStore.save({
      id: 'i137-probe-stale',
      type: 'architecture',
      title: `Design doc: ${SCOPE}`,
      content: `analysis of ${SCOPE}`,
      maturity: 'verified',
      layer: 'tech',
      created: twoHoursAgo,
      lastReferenced: twoHoursAgo,
      contributors: ['analyst'],
      projects: [],
      tags: [SCOPE, 'design-doc'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'agent',
    });

    const result = await knowledgeSync.runSyncCycle(repoDir);
    expect(result.stale.length).toBeGreaterThan(0);
    expect(recordPattern).toHaveBeenCalledTimes(1);
    expect(recordPattern).toHaveBeenCalledWith(expect.objectContaining({
      type: 'trend',
      tags: ['monitor'],
    }));
  });
});
