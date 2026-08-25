/**
 * Library service 测试 — #155 T5 阅览室聚合只读层
 *
 * tmp 目录造两仓 fixture（.studio/ 下 specs/research/CONTEXT.md/legacy-sdd +
 * 仓根 docs/adr/，全齐），
 * 覆盖：缺省聚合、project 收窄、search、legacy 标记、projectId 真值、
 * 路径穿越拒绝、单仓失败容错。PMO 项目清单用 vi.mock project.service。
 */

import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mock PMO 项目清单 ──

const mockList = vi.fn() as Mock;
const mockGet = vi.fn() as Mock;

vi.mock('../../pmo/project.service.js', () => ({
  projectService: {
    list: (...args: unknown[]) => mockList(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

import { listLibraryDocs, getLibraryDoc } from '../library.service.js';

// ── Fixtures ──

let tmpRoot: string;
let repoA: string;
let repoB: string;

function write(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const LEGACY_REQ = `---
id: "doc-legacy-1"
slug: "old-doc"
title: "遗产文档"
status: "done"
tags: [sdd, legacy]
updatedAt: "2026-07-01T00:00:00Z"
---

# 遗产需求正文

legacy body 含关键词 frobnicate。`;

const projects = () => [
  { id: 'proj-a', pmoNumber: 'PMO-1', title: '项目甲', gitRepo: repoA },
  { id: 'proj-b', pmoNumber: 'PMO-2', title: '项目乙', gitRepo: repoB },
  { id: 'proj-c', pmoNumber: 'PMO-3', title: '无仓项目', gitRepo: null },
  // 单仓失败容错：gitRepo 指向不存在的路径，不应炸整体
  { id: 'proj-d', pmoNumber: 'PMO-4', title: '坏仓项目', gitRepo: path.join(tmpRoot, 'no-such-repo') },
];

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'library-service-'));
  repoA = path.join(tmpRoot, 'repo-a');
  repoB = path.join(tmpRoot, 'repo-b');

  write(path.join(repoA, '.studio/specs/spec-a.md'), `---
title: "规格甲"
updatedAt: "2026-08-01T00:00:00Z"
---

# 规格甲正文

spec body keyword alpha。`);
  write(path.join(repoA, '.studio/research/research-a.md'), `# 调研甲

research body keyword BETA。`);
  write(path.join(repoA, 'docs/adr/adr-a.md'), `---
title: "ADR 甲"
---

决策正文。`);
  write(path.join(repoA, '.studio/CONTEXT.md'), `# 仓甲上下文

context body。`);
  write(path.join(repoA, '.studio/legacy-sdd/old-doc/requirement.md'), LEGACY_REQ);
  write(path.join(repoA, '.studio/legacy-sdd/old-doc/design.md'), `---
title: "遗产文档"
---

设计段正文。`);
  // old-doc 无 task.md → detail.task 应为 null

  write(path.join(repoB, '.studio/specs/spec-b.md'), `---
title: "规格乙"
updatedAt: "2026-08-02T00:00:00Z"
---

规格乙正文。`);

  mockList.mockImplementation(async () => projects());
  mockGet.mockImplementation(async (id: string) => projects().find(p => p.id === id) ?? null);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── listLibraryDocs ──

describe('listLibraryDocs', () => {
  it('缺省聚合全部有 gitRepo 的项目，无仓项目被排除，单仓失败不炸整体', async () => {
    const docs = await listLibraryDocs({});
    const ids = docs.map(d => d.id);

    expect(ids).toContain('proj-a:specs/spec-a.md');
    expect(ids).toContain('proj-a:research/research-a.md');
    expect(ids).toContain('proj-a:docs/adr/adr-a.md');
    expect(ids).toContain('proj-a:CONTEXT.md');
    expect(ids).toContain('proj-a:legacy-sdd/old-doc');
    expect(ids).toContain('proj-b:specs/spec-b.md');
    // 无 gitRepo 的 proj-c 不产生任何条目
    expect(ids.some(id => id.startsWith('proj-c:'))).toBe(false);
    // 坏仓 proj-d 不炸整体、也不产生条目
    expect(ids.some(id => id.startsWith('proj-d:'))).toBe(false);
  });

  it('kind 与 title 兜底链正确（frontmatter title → H1 → 文件名）', async () => {
    const docs = await listLibraryDocs({});
    const byId = new Map(docs.map(d => [d.id, d]));

    expect(byId.get('proj-a:specs/spec-a.md')).toMatchObject({ kind: 'spec', title: '规格甲', legacy: false });
    expect(byId.get('proj-a:research/research-a.md')).toMatchObject({ kind: 'research', title: '调研甲' });
    expect(byId.get('proj-a:docs/adr/adr-a.md')).toMatchObject({ kind: 'adr', title: 'ADR 甲' });
    expect(byId.get('proj-a:CONTEXT.md')).toMatchObject({ kind: 'context', title: '仓甲上下文' });
  });

  it('legacy 文档打 legacy 标记并带 status/tags，projectId 填真值', async () => {
    const docs = await listLibraryDocs({});
    const legacy = docs.find(d => d.id === 'proj-a:legacy-sdd/old-doc');

    expect(legacy).toMatchObject({
      kind: 'legacy',
      legacy: true,
      title: '遗产文档',
      projectId: 'proj-a',
      pmoNumber: 'PMO-1',
      path: 'legacy-sdd/old-doc',
      status: 'done',
      tags: ['sdd', 'legacy'],
      updatedAt: '2026-07-01T00:00:00Z',
    });
  });

  it('frontmatter updatedAt 优先，缺省回退文件 mtime', async () => {
    const docs = await listLibraryDocs({});
    const byId = new Map(docs.map(d => [d.id, d]));

    expect(byId.get('proj-a:specs/spec-a.md')?.updatedAt).toBe('2026-08-01T00:00:00Z');
    // 无 frontmatter 的 research-a 回退 mtime（非空 ISO 串）
    expect(byId.get('proj-a:research/research-a.md')?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('?project= 收窄到单项目', async () => {
    const docs = await listLibraryDocs({ projectId: 'proj-b' });
    expect(docs.map(d => d.id)).toEqual(['proj-b:specs/spec-b.md']);
  });

  it('search 匹配 title 与正文，大小写不敏感', async () => {
    // title 命中
    const byTitle = await listLibraryDocs({ search: '规格甲' });
    expect(byTitle.map(d => d.id)).toEqual(['proj-a:specs/spec-a.md']);

    // 仅正文命中（legacy 正文 = requirement body）
    const byBody = await listLibraryDocs({ search: 'frobnicate' });
    expect(byBody.map(d => d.id)).toEqual(['proj-a:legacy-sdd/old-doc']);

    // 大小写不敏感
    const byCase = await listLibraryDocs({ search: 'beta' });
    expect(byCase.map(d => d.id)).toEqual(['proj-a:research/research-a.md']);
  });
});

// ── getLibraryDoc ──

describe('getLibraryDoc', () => {
  it('普通文档：content 为去 frontmatter 正文', async () => {
    const doc = await getLibraryDoc('proj-a:specs/spec-a.md');

    expect(doc).toMatchObject({
      id: 'proj-a:specs/spec-a.md',
      title: '规格甲',
      kind: 'spec',
      legacy: false,
      projectId: 'proj-a',
      pmoNumber: 'PMO-1',
      path: 'specs/spec-a.md',
    });
    expect(doc?.content).toContain('spec body keyword alpha');
    expect(doc?.content).not.toContain('updatedAt:');
  });

  it('legacy 文档：content = requirement body，另带 design/task（缺层为 null）', async () => {
    const doc = await getLibraryDoc('proj-a:legacy-sdd/old-doc');

    expect(doc).toMatchObject({ kind: 'legacy', legacy: true, title: '遗产文档', status: 'done' });
    expect(doc?.content).toContain('legacy body 含关键词 frobnicate');
    expect(doc?.requirement).toBe(doc?.content);
    expect(doc?.design).toContain('设计段正文');
    expect(doc?.task).toBeNull();
  });

  it('未知项目 / 未知文档 / 非法 id → null', async () => {
    expect(await getLibraryDoc('proj-x:specs/spec-a.md')).toBeNull();
    expect(await getLibraryDoc('proj-a:specs/no-such.md')).toBeNull();
    expect(await getLibraryDoc('no-colon')).toBeNull();
    expect(await getLibraryDoc('proj-a:')).toBeNull();
    // 不在已知文档面内的路径 → null
    expect(await getLibraryDoc('proj-a:random/file.md')).toBeNull();
  });

  it('adr 文档：仓根 docs/adr/ 面读取，越出该面即 null', async () => {
    const doc = await getLibraryDoc('proj-a:docs/adr/adr-a.md');

    expect(doc).toMatchObject({
      id: 'proj-a:docs/adr/adr-a.md',
      title: 'ADR 甲',
      kind: 'adr',
      path: 'docs/adr/adr-a.md',
    });
    expect(doc?.content).toContain('决策正文。');
    // 越出 docs/adr/ 面根（含仓内其他位置）一律拒绝
    expect(await getLibraryDoc('proj-a:docs/adr/../specs/spec-a.md')).toBeNull();
    expect(await getLibraryDoc('proj-a:docs/adr/../../package.json')).toBeNull();
  });

  it('路径穿越拒绝：resolve 出 .studio/ 根即 null', async () => {
    expect(await getLibraryDoc('proj-a:specs/../../package.json')).toBeNull();
    expect(await getLibraryDoc('proj-a:..%2f..%2fsecret.md'.replace(/%2f/gi, '/'))).toBeNull();
    expect(await getLibraryDoc('proj-a:legacy-sdd/../specs')).toBeNull();
    expect(await getLibraryDoc('proj-a:legacy-sdd/a/b')).toBeNull();
  });
});

// ── #321：FileStore 读穿 seam 行为 ──

describe('读穿缓存（#321）', () => {
  it('连续两次 listLibraryDocs，第二次零文档内容 readFile（stat 校验命中缓存）', async () => {
    await listLibraryDocs({}); // 确保缓存已填充
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const fixtureReads = () =>
      readSpy.mock.calls.filter(c => String(c[0]).startsWith(tmpRoot)).length;

    const docs = await listLibraryDocs({});
    expect(docs.length).toBeGreaterThan(0);
    expect(fixtureReads()).toBe(0); // 含 legacy requirement.md，全部命中缓存
    readSpy.mockRestore();
  });

  it('连续两次 getLibraryDoc，第二次零 readFile', async () => {
    await getLibraryDoc('proj-a:specs/spec-a.md'); // 填充缓存
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const fixtureReads = () =>
      readSpy.mock.calls.filter(c => String(c[0]).startsWith(tmpRoot)).length;

    const doc = await getLibraryDoc('proj-a:specs/spec-a.md');
    expect(doc?.title).toBe('规格甲');
    expect(fixtureReads()).toBe(0);
    readSpy.mockRestore();
  });

  it('外部编辑文档（绕过 API，mtime 变化）后下一次 list 反映新内容，search 命中新关键词', async () => {
    await listLibraryDocs({}); // 填充缓存
    const specA = path.join(repoA, '.studio/specs/spec-a.md');
    const original = fs.readFileSync(specA, 'utf8');
    try {
      fs.writeFileSync(specA, `---\ntitle: "规格甲改"\nupdatedAt: "2026-08-03T00:00:00Z"\n---\n\n新关键词 zworge。`);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(specA, future, future);

      const docs = await listLibraryDocs({});
      expect(docs.find(d => d.id === 'proj-a:specs/spec-a.md')?.title).toBe('规格甲改');

      const hit = await listLibraryDocs({ search: 'zworge' });
      expect(hit.map(d => d.id)).toEqual(['proj-a:specs/spec-a.md']);
    } finally {
      // 还原 fixture 并推进 mtime，避免污染后续测试
      fs.writeFileSync(specA, original);
      const future = new Date(Date.now() + 6000);
      fs.utimesSync(specA, future, future);
    }
  });

  it('对外部项目仓零写入（list/detail 全程无 writeFile）', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    await listLibraryDocs({});
    await getLibraryDoc('proj-a:legacy-sdd/old-doc');
    const fixtureWrites = writeSpy.mock.calls.filter(c => String(c[0]).startsWith(tmpRoot));
    expect(fixtureWrites).toEqual([]);
    writeSpy.mockRestore();
  });
});

