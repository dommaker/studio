/**
 * devops.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 publishPackage 的流水线分支。execSync 被 mock（不执行真实 git/npm），
 * fs 为真实模块但只作用于临时目录中的假包。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockExec = vi.fn();

vi.mock('child_process', () => ({ execSync: mockExec }));

import { devopsTools } from '../devops.tools.js';

const publishPackage = devopsTools[0];

let pkgDir: string;

function makePkg(version = '1.2.3', withDist = false) {
  pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-devops-tools-'));
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@acme/pkg', version }));
  if (withDist) {
    for (const f of ['dist/core/constraints/prompt-injection.js', 'dist/knowledge/doctor.js', 'dist/index.js']) {
      fs.mkdirSync(path.dirname(path.join(pkgDir, f)), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, f), '// built');
    }
  }
  return pkgDir;
}

/** 默认 execSync 行为：无 remote、工作区干净、tsc 通过。 */
function mockHappyGit() {
  mockExec.mockImplementation((cmd: string) => {
    if (cmd === 'git remote get-url origin') throw new Error('no remote');
    if (cmd === 'git status --porcelain -uno') return '';
    if (cmd === 'npx tsc') return '';
    throw new Error(`unexpected exec: ${cmd}`);
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => { if (pkgDir) fs.rmSync(pkgDir, { recursive: true, force: true }); });

describe('devops.tools', () => {
  it('仅导出 publishPackage，schema required=[packagePath]', () => {
    expect(devopsTools.map(t => t.name)).toEqual(['publishPackage']);
    expect(publishPackage.inputSchema.required).toEqual(['packagePath']);
    expect(publishPackage.inputSchema.properties.dryRun.default).toBe('false');
  });

  it('package.json 不存在 → Not a package', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-devops-empty-'));
    const result = await publishPackage.handler({ packagePath: dir });
    expect(result).toEqual({ success: false, error: `Not a package: ${dir}`, steps: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('有未提交变更 → 拒绝发布', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') throw new Error('no remote');
      if (cmd === 'git status --porcelain -uno') return ' M src/a.ts\n';
      throw new Error(`unexpected exec: ${cmd}`);
    });
    const result = await publishPackage.handler({ packagePath: makePkg() });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Uncommitted changes');
  });

  it('非 git 仓库 → Not a git repo', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') throw new Error('no remote');
      if (cmd === 'git status --porcelain -uno') throw new Error('fatal: not a git repository');
      throw new Error(`unexpected exec: ${cmd}`);
    });
    const result = await publishPackage.handler({ packagePath: makePkg() });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a git repo');
  });

  it('tsc 失败 → TypeScript compilation failed + compileErrors', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') throw new Error('no remote');
      if (cmd === 'git status --porcelain -uno') return '';
      if (cmd === 'npx tsc') { const e: any = new Error('tsc exit 1'); e.stderr = 'error TS1005'; throw e; }
      throw new Error(`unexpected exec: ${cmd}`);
    });
    const result = await publishPackage.handler({ packagePath: makePkg() });
    expect(result.success).toBe(false);
    expect(result.error).toBe('TypeScript compilation failed');
    expect(result.compileErrors).toBe('error TS1005');
  });

  it('dryRun：跳过节发布步骤，返回 wouldPublish（patch 默认）', async () => {
    mockHappyGit();
    const result = await publishPackage.handler({ packagePath: makePkg('1.2.3'), dryRun: 'true' });
    expect(result).toMatchObject({ success: true, dryRun: true, wouldPublish: '@acme/pkg@1.2.4' });
    const stepText = result.steps.map((s: any) => `${s.step}:${s.status}`);
    expect(stepText).toContain('package: @acme/pkg@1.2.3:ok');
    expect(stepText).toContain('git status: clean:ok');
    expect(stepText).toContain('tsc: build:ok');
    expect(stepText).toContain('dist verify: 3 missing:fail');
    expect(stepText).toContain('npm publish: skipped (dry-run):skip');
    expect(stepText).toContain('gh release: skipped (dry-run):skip');
  });

  it('dryRun minor 版本递增', async () => {
    mockHappyGit();
    const result = await publishPackage.handler({ packagePath: makePkg('1.2.3'), dryRun: 'true', bumpType: 'minor' });
    expect(result.wouldPublish).toBe('@acme/pkg@1.3.0');
  });

  it('npm version 失败 → 错误透出', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') throw new Error('no remote');
      if (cmd === 'git status --porcelain -uno') return '';
      if (cmd === 'npx tsc') return '';
      if (cmd.startsWith('npm version')) throw new Error('boom');
      throw new Error(`unexpected exec: ${cmd}`);
    });
    const result = await publishPackage.handler({ packagePath: makePkg('1.2.3', true) });
    expect(result).toMatchObject({ success: false, error: 'npm version failed: boom' });
  });

  it('完整发布路径成功（git/npm/gh 全 mock）', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return 'git@github.com:acme/pkg.git\n';
      if (cmd === 'git status --porcelain -uno') return '';
      if (cmd === 'npx tsc') return '';
      if (cmd.startsWith('npm version')) return 'v1.2.3\n';
      if (cmd.startsWith('git add package.json')) return '';
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return 'main\n';
      if (cmd.startsWith('git push')) return '';
      if (cmd === 'npm publish') return '+ @acme/pkg@1.2.3\n';
      if (cmd.startsWith('gh release create')) return 'https://github.com/acme/pkg/releases/tag/v1.2.3\n';
      throw new Error(`unexpected exec: ${cmd}`);
    });
    const result = await publishPackage.handler({ packagePath: makePkg('1.2.3', true) });
    expect(result).toMatchObject({
      success: true,
      package: '@acme/pkg',
      version: '1.2.3',
      tag: 'v1.2.3',
      npmUrl: 'https://www.npmjs.com/package/@acme/pkg/v/1.2.3',
      githubRelease: 'https://github.com/acme/pkg/releases/tag/v1.2.3',
    });
    const stepText = result.steps.map((s: any) => `${s.step}:${s.status}`);
    expect(stepText).toContain('dist verify: all critical files present:ok');
    expect(stepText).toContain('git: committed + tagged v1.2.3:ok');
    expect(stepText).toContain('git push: main + tag:ok');
  });
});
