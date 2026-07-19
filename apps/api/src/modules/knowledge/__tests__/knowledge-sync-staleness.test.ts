/**
 * R5 验收测试（断点 J）— 过期监控修复
 *
 * scope registry 修复后（指向真实存在的路径），改动（git commit）一个
 * 被监控文件 → detectStaleness 必须在对应 scope 上报 staleness 信号。
 *
 * 夹具：tmp git repo（真实 git log）+ tmp 知识库（真实 FileKnowledgeStore，
 * 预置 design-doc 条目，lastReferenced 早于文件 commit）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// knowledge-sync.service 的存储依赖隔离到 tmp 目录（真实 FileKnowledgeStore）
vi.mock('../knowledge-bus.service.js', async () => {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  const osMod = await import('os');
  const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ksync-store-'));

  const harness = await vi.importActual<any>('@dommaker/harness');
  const { FileKnowledgeStore, KnowledgeIngest } = harness;
  const sharedStore = new FileKnowledgeStore({ baseDir: tmpDir });

  (globalThis as any).__ksyncTest = {
    tmpDir,
    sharedStore,
  };

  return {
    UNIFIED_KNOWLEDGE_DIR: tmpDir,
    sharedStore,
    sharedIngest: new KnowledgeIngest(sharedStore),
    sharedLifecycle: { recordReference: vi.fn() },
    upsertKnowledge: vi.fn(),
    knowledgeBus: { recordPattern: vi.fn().mockResolvedValue(undefined) },
    scheduleVectorDbSync: vi.fn(),
  };
});

import { knowledgeSync } from '../knowledge-sync.service.js';

const SCOPE = 'r5-watched-scope';
const WATCHED_FILE = 'src/watched.ts';

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function saveDesignDoc(store: any, id: string, scope: string, lastReferenced: string) {
  store.save({
    id,
    type: 'architecture',
    title: `Design doc: ${scope}`,
    content: `analysis of ${scope}`,
    maturity: 'verified',
    layer: 'tech',
    created: lastReferenced,
    lastReferenced,
    contributors: ['analyst'],
    projects: [],
    tags: [scope, 'design-doc'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'reference',
    origin: 'agent',
  });
}

describe('R5: KnowledgeSync staleness signal (fixed scope paths)', () => {
  let repoDir: string;
  let storeDir: string;
  let sharedStore: any;

  beforeAll(() => {
    ({ tmpDir: storeDir, sharedStore } = (globalThis as any).__ksyncTest);

    // tmp git repo，被监控文件有一次 commit
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksync-repo-'));
    git(repoDir, 'init -q');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, WATCHED_FILE), 'export const v = 1;\n');
    git(repoDir, 'add -A');
    git(repoDir, 'commit -qm init');

    // 注册 scope（指向 repo 内真实文件），并预置 2h 前更新的 design-doc
    knowledgeSync.registerScope(SCOPE, {
      files: [WATCHED_FILE],
      title: 'R5 watched scope',
      knowledgeType: 'architecture',
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveDesignDoc(sharedStore, 'r5-probe-stale', SCOPE, twoHoursAgo);
  });

  afterAll(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('touching a monitored file (git commit) produces a staleness signal for its scope', () => {
    const { stale } = knowledgeSync.detectStaleness(repoDir);
    const hit = stale.find(s => s.scope === SCOPE);
    expect(hit).toBeDefined();
    expect(hit!.changedFiles).toContain(WATCHED_FILE);
    expect(hit!.stalenessHours).toBeGreaterThanOrEqual(1);
    expect(hit!.knowledgeEntryId).toBe('r5-probe-stale');
  });

  it('scope watching an untouched path stays fresh (no false positive)', () => {
    const FRESH_SCOPE = 'r5-fresh-scope';
    knowledgeSync.registerScope(FRESH_SCOPE, {
      files: ['src/never-committed.ts'],
      title: 'R5 fresh scope',
      knowledgeType: 'architecture',
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveDesignDoc(sharedStore, 'r5-probe-fresh', FRESH_SCOPE, twoHoursAgo);

    const { stale } = knowledgeSync.detectStaleness(repoDir);
    expect(stale.find(s => s.scope === FRESH_SCOPE)).toBeUndefined();
  });

  it('entry refreshed within the last hour is not stale (freshness threshold)', () => {
    const RECENT_SCOPE = 'r5-recent-scope';
    knowledgeSync.registerScope(RECENT_SCOPE, {
      files: [WATCHED_FILE],
      title: 'R5 recent scope',
      knowledgeType: 'architecture',
    });
    // 同是被监控文件，但知识刚刷新过（<1h）→ 不报过期
    saveDesignDoc(sharedStore, 'r5-probe-recent', RECENT_SCOPE, new Date().toISOString());

    const { stale } = knowledgeSync.detectStaleness(repoDir);
    expect(stale.find(s => s.scope === RECENT_SCOPE)).toBeUndefined();
  });
});
