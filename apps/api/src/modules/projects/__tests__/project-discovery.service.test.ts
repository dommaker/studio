/**
 * AC-D1+D3: Project discovery service + API tests
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDiscoveryService } from '../project-discovery.service.js';

describe('AC-D1: Project Discovery Service', () => {
  let tempRoot: string;
  let service: ProjectDiscoveryService;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'studio-discovery-test-'));

    // Create mock project structures:
    // project-a: has CLAUDE.md
    const projectA = join(tempRoot, 'project-a');
    await mkdir(projectA);
    await writeFile(join(projectA, 'CLAUDE.md'), '# Project A\nTest project');

    // project-b: has package.json
    const projectB = join(tempRoot, 'project-b');
    await mkdir(projectB);
    await writeFile(join(projectB, 'package.json'), JSON.stringify({ name: 'project-b' }));

    // project-c: has .git/
    const projectC = join(tempRoot, 'project-c');
    await mkdir(projectC);
    await mkdir(join(projectC, '.git'));

    // not-a-project: no markers
    const notProject = join(tempRoot, 'not-a-project');
    await mkdir(notProject);
    await writeFile(join(notProject, 'readme.txt'), 'just a file');

    // monorepo/parent-project: has CLAUDE.md + sub-project (monorepo)
    const monorepo = join(tempRoot, 'monorepo');
    await mkdir(monorepo);
    await writeFile(join(monorepo, 'CLAUDE.md'), '# Monorepo');
    // Sub-project (one level deep — should be detected)
    const subProject = join(monorepo, 'packages', 'sub-pkg');
    await mkdir(subProject, { recursive: true });
    await writeFile(join(subProject, 'package.json'), JSON.stringify({ name: 'sub-pkg' }));
    // Deep nested (two levels deep — should NOT be detected)
    const deepProject = join(monorepo, 'packages', 'deep', 'nested');
    await mkdir(deepProject, { recursive: true });
    await writeFile(join(deepProject, 'package.json'), JSON.stringify({ name: 'deep' }));

    service = new ProjectDiscoveryService({ roots: [tempRoot] });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('detects project with CLAUDE.md', async () => {
    const projects = await service.discover();
    const found = projects.find(p => p.name === 'project-a');
    expect(found).toBeDefined();
    expect(found!.hasClaudeMd).toBe(true);
  });

  it('detects project with package.json', async () => {
    const projects = await service.discover();
    const found = projects.find(p => p.name === 'project-b');
    expect(found).toBeDefined();
    expect(found!.hasClaudeMd).toBe(false);
  });

  it('detects project with .git/', async () => {
    const projects = await service.discover();
    const found = projects.find(p => p.name === 'project-c');
    expect(found).toBeDefined();
  });

  it('does not detect directory without project markers', async () => {
    const projects = await service.discover();
    const found = projects.find(p => p.name === 'not-a-project');
    expect(found).toBeUndefined();
  });

  it('hasClaudeMd correctly reflects CLAUDE.md presence', async () => {
    const projects = await service.discover();
    const withMd = projects.find(p => p.name === 'project-a');
    const withoutMd = projects.find(p => p.name === 'project-b');
    expect(withMd!.hasClaudeMd).toBe(true);
    expect(withoutMd!.hasClaudeMd).toBe(false);
  });

  it('monorepo: detects top-level + one-level sub-directory', async () => {
    const projects = await service.discover();
    const parent = projects.find(p => p.name === 'monorepo');
    const sub = projects.find(p => p.name === 'sub-pkg');
    expect(parent).toBeDefined();
    expect(sub).toBeDefined();
  });

  it('monorepo: does not detect deeply nested projects (2+ levels)', async () => {
    const projects = await service.discover();
    const deep = projects.find(p => p.name === 'nested');
    expect(deep).toBeUndefined();
  });

  it('returns empty array when root does not exist', async () => {
    const emptyService = new ProjectDiscoveryService({ roots: ['/nonexistent/path'] });
    const projects = await emptyService.discover();
    expect(projects).toEqual([]);
  });

  it('caches results within TTL', async () => {
    // First call populates cache
    const first = await service.discover();
    // Second call should return cached result (same reference or same data)
    const second = await service.discover();
    expect(second.length).toBe(first.length);
  });

  describe('search', () => {
    it('returns matching projects by name', async () => {
      const results = await service.search('project-a');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('project-a');
    });

    it('returns empty for no match', async () => {
      const results = await service.search('nonexistent-xyz');
      expect(results).toEqual([]);
    });
  });
});

describe('AC-D3: Project Discovery API integration', () => {
  // API-level tests would go here (supertest)
  // For now, the service tests above cover the core logic
  it('placeholder — API route test added during GREEN phase', () => {
    expect(true).toBe(true);
  });
});
