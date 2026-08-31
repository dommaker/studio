/**
 * knowledge-design-doc 直接单测（#343 review：迁出文件零直接测试不可提交）
 *
 * 覆盖 upsertKnowledge 四分支（created/unchanged/updated/refreshed）与
 * checkDocumentFreshness（stale 命中 / 无 repoDir 早退）。
 * 存储依赖经 vi.mock knowledge-singletons 隔离到 tmp 目录（真实 FileKnowledgeStore + KnowledgeIngest）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const { recordReferenceMock, scheduleSyncMock } = vi.hoisted(() => ({
  recordReferenceMock: vi.fn(),
  scheduleSyncMock: vi.fn(),
}));

vi.mock('../knowledge-singletons.js', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');
  const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'kdd-store-'));

  const harness = await vi.importActual<any>('@dommaker/harness');
  const { FileKnowledgeStore, KnowledgeIngest } = harness;
  const sharedStore = new FileKnowledgeStore({ baseDir: tmpDir });

  (globalThis as any).__kddTest = { tmpDir, sharedStore };

  return {
    UNIFIED_KNOWLEDGE_DIR: tmpDir,
    sharedStore,
    sharedIngest: new KnowledgeIngest(sharedStore),
    sharedLifecycle: { recordReference: recordReferenceMock },
    scheduleVectorDbSync: scheduleSyncMock,
  };
});

import { upsertKnowledge, checkDocumentFreshness } from '../knowledge-design-doc.js';

const CONTENT_V1 = 'architecture analysis for kdd scope: module boundaries, data flow, and failure modes documented at length so the ingest quality gate is satisfied.';

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

describe('upsertKnowledge', () => {
  it('creates a design-doc entry on first write', async () => {
    const result = await upsertKnowledge({ scope: 'kdd-created', title: 'KDD created scope', content: CONTENT_V1, source: 'analyst' });
    expect(result.action).toBe('created');
    expect(scheduleSyncMock).toHaveBeenCalled();

    const { sharedStore } = (globalThis as any).__kddTest;
    const saved = sharedStore.list({ tags: ['design-doc'] }).find((e: any) => e.tags?.includes('kdd-created'));
    expect(saved).toBeDefined();
    expect(saved.content).toBe(CONTENT_V1);
  });

  it('returns unchanged when content is identical and lastReferenced is fresh', async () => {
    const first = await upsertKnowledge({ scope: 'kdd-unchanged', title: 'KDD unchanged scope', content: CONTENT_V1 });
    expect(first.action).toBe('created');
    const second = await upsertKnowledge({ scope: 'kdd-unchanged', title: 'KDD unchanged scope', content: CONTENT_V1 });
    expect(second.action).toBe('unchanged');
    expect(second.entryId).toBe(first.entryId);
    expect(recordReferenceMock).not.toHaveBeenCalledWith(first.entryId, 'analyst');
  });

  it('refreshes lastReferenced when content identical but entry is stale (>6h)', async () => {
    const { sharedStore } = (globalThis as any).__kddTest;
    const old = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    sharedStore.save({
      id: 'kdd-refresh-entry',
      type: 'architecture',
      title: 'KDD refresh scope',
      content: CONTENT_V1,
      maturity: 'verified',
      layer: 'tech',
      created: old,
      lastReferenced: old,
      contributors: ['analyst'],
      projects: [],
      tags: ['kdd-refresh', 'design-doc'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'agent',
    });

    const result = await upsertKnowledge({ scope: 'kdd-refresh', title: 'KDD refresh scope', content: CONTENT_V1 });
    expect(result.action).toBe('refreshed');
    expect(result.entryId).toBe('kdd-refresh-entry');
    expect(recordReferenceMock).toHaveBeenCalledWith('kdd-refresh-entry', 'analyst');
  });

  it('updates content and resets maturity when content differs', async () => {
    const { sharedStore } = (globalThis as any).__kddTest;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sharedStore.save({
      id: 'kdd-update-entry',
      type: 'architecture',
      title: 'KDD update scope',
      content: 'stale outdated analysis that no longer matches the current module design at all',
      maturity: 'proven',
      layer: 'tech',
      created: old,
      lastReferenced: old,
      contributors: ['analyst'],
      projects: [],
      tags: ['kdd-update', 'design-doc'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'agent',
    });

    const contentV2 = CONTENT_V1 + ' revised after the module split: seams moved, memo wrapper added.';
    const result = await upsertKnowledge({ scope: 'kdd-update', title: 'KDD update scope', content: contentV2 });
    expect(result.action).toBe('updated');
    expect(result.entryId).toBe('kdd-update-entry');

    const saved = sharedStore.get('kdd-update-entry');
    expect(saved?.content).toBe(contentV2);
    expect(saved?.maturity).toBe('verified');
    expect(scheduleSyncMock).toHaveBeenCalled();
  });
});

describe('checkDocumentFreshness', () => {
  let repoDir: string;
  const { sharedStore } = (globalThis as any).__kddTest;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdd-repo-'));
    git(repoDir, 'init -q');
    fs.mkdirSync(path.join(repoDir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'utils', 'helper.ts'), 'export const v = 1;\n');
    git(repoDir, 'add -A');
    git(repoDir, 'commit -qm init');
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('flags design-doc entries whose scope files changed after lastReferenced (>7d old)', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    sharedStore.save({
      id: 'kdd-stale-entry',
      type: 'architecture',
      title: 'KDD freshness scope',
      content: 'design analysis tied to src/utils code',
      maturity: 'verified',
      layer: 'tech',
      created: tenDaysAgo,
      lastReferenced: tenDaysAgo,
      contributors: ['analyst'],
      projects: [],
      tags: ['src-utils', 'design-doc'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference',
      origin: 'agent',
    });

    const stale = checkDocumentFreshness(repoDir);
    const hit = stale.find(s => s.entryId === 'kdd-stale-entry');
    expect(hit).toBeDefined();
    expect(hit?.scope).toBe('src-utils');
    expect(hit?.staleSince).toBeDefined();
  });

  it('returns empty when repoDir is not provided', () => {
    expect(checkDocumentFreshness()).toEqual([]);
  });
});
