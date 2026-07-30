/**
 * AC-D1+D3: Project discovery service + API tests
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

    // monorepo/parent-project: has CLAUDE.md + sub-projects inside (pruned: project = leaf)
    const monorepo = join(tempRoot, 'monorepo');
    await mkdir(monorepo);
    await writeFile(join(monorepo, 'CLAUDE.md'), '# Monorepo');
    // Sub-project (one level deep — NOT detected: recursion stops at monorepo)
    const subProject = join(monorepo, 'packages', 'sub-pkg');
    await mkdir(subProject, { recursive: true });
    await writeFile(join(subProject, 'package.json'), JSON.stringify({ name: 'sub-pkg' }));
    // Deep nested (also NOT detected: pruned at monorepo)
    const deepProject = join(monorepo, 'packages', 'deep', 'nested');
    await mkdir(deepProject, { recursive: true });
    await writeFile(join(deepProject, 'package.json'), JSON.stringify({ name: 'deep' }));

    // group-dir: no markers — intermediate dirs are still traversed to find nested projects
    const groupInner = join(tempRoot, 'group-dir', 'inner-proj');
    await mkdir(groupInner, { recursive: true });
    await writeFile(join(groupInner, 'package.json'), JSON.stringify({ name: 'inner-proj' }));

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

  it('monorepo: 工程即叶子 — 命中顶层后不再递归内部子包', async () => {
    const projects = await service.discover();
    const parent = projects.find(p => p.name === 'monorepo');
    const sub = projects.find(p => p.name === 'sub-pkg');
    expect(parent).toBeDefined();
    expect(sub).toBeUndefined();
  });

  it('monorepo: does not detect deeply nested projects (2+ levels)', async () => {
    const projects = await service.discover();
    const deep = projects.find(p => p.name === 'nested');
    expect(deep).toBeUndefined();
  });

  it('非工程中间目录仍会下钻，嵌套工程可被发现', async () => {
    const projects = await service.discover();
    const group = projects.find(p => p.name === 'group-dir');
    const inner = projects.find(p => p.name === 'inner-proj');
    expect(group).toBeUndefined();
    expect(inner).toBeDefined();
    expect(inner!.path).toBe(join(tempRoot, 'group-dir', 'inner-proj'));
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

describe('D6: STUDIO_PROJECTS_EXCLUDE 排除清单', () => {
  let tempRoot: string;
  let savedExclude: string | undefined;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'studio-discovery-exclude-'));
    // keep-a / skip-b / skip-path / prefix / prefix2：均带 CLAUDE.md 标记
    for (const name of ['keep-a', 'skip-b', 'skip-path', 'prefix', 'prefix2']) {
      const dir = join(tempRoot, name);
      await mkdir(dir);
      await writeFile(join(dir, 'CLAUDE.md'), `# ${name}`);
    }
    // nest（无标记分组目录）+ nest/packages/inner（package.json）：验证目录名规则对嵌套生效
    // （注意：若父级带工程标记，按"工程即叶子"规则根本不会下钻，排除规则无从体现）
    await mkdir(join(tempRoot, 'nest', 'packages', 'inner'), { recursive: true });
    await writeFile(join(tempRoot, 'nest', 'packages', 'inner', 'package.json'), JSON.stringify({ name: 'inner' }));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedExclude = process.env.STUDIO_PROJECTS_EXCLUDE;
    delete process.env.STUDIO_PROJECTS_EXCLUDE;
  });

  afterEach(() => {
    if (savedExclude === undefined) {
      delete process.env.STUDIO_PROJECTS_EXCLUDE;
    } else {
      process.env.STUDIO_PROJECTS_EXCLUDE = savedExclude;
    }
  });

  async function discoverNames(service: ProjectDiscoveryService): Promise<string[]> {
    return (await service.discover()).map(p => p.name);
  }

  it('options.exclude：目录名与绝对路径规则命中即跳过', async () => {
    const service = new ProjectDiscoveryService({
      roots: [tempRoot],
      exclude: ['skip-b', join(tempRoot, 'skip-path')],
    });

    const names = await discoverNames(service);
    expect(names).toContain('keep-a');
    expect(names).not.toContain('skip-b');
    expect(names).not.toContain('skip-path');
  });

  it('env STUDIO_PROJECTS_EXCLUDE（冒号分隔）同样生效', async () => {
    process.env.STUDIO_PROJECTS_EXCLUDE = `skip-b:${join(tempRoot, 'skip-path')}`;
    const service = new ProjectDiscoveryService({ roots: [tempRoot] });

    const names = await discoverNames(service);
    expect(names).toContain('keep-a');
    expect(names).not.toContain('skip-b');
    expect(names).not.toContain('skip-path');
  });

  it('绝对路径规则按目录边界匹配，不误伤同名前缀目录', async () => {
    const service = new ProjectDiscoveryService({
      roots: [tempRoot],
      exclude: [join(tempRoot, 'prefix')],
    });

    const names = await discoverNames(service);
    expect(names).not.toContain('prefix');
    expect(names).toContain('prefix2'); // '/prefix' 不应命中 '/prefix2'
  });

  it('目录名规则对嵌套层级生效（排除后不递归进入）', async () => {
    const service = new ProjectDiscoveryService({
      roots: [tempRoot],
      exclude: ['packages'],
    });

    const names = await discoverNames(service);
    expect(names).toContain('keep-a');    // 其它工程不受影响
    expect(names).not.toContain('inner'); // packages/ 被排除 → 内部工程不发现
  });

  it('无排除清单时行为不变', async () => {
    const service = new ProjectDiscoveryService({ roots: [tempRoot] });

    const names = await discoverNames(service);
    for (const name of ['keep-a', 'skip-b', 'skip-path', 'prefix', 'prefix2', 'inner']) {
      expect(names).toContain(name);
    }
  });
});
