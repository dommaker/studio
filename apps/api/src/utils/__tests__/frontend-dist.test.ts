/**
 * frontend-dist.ts 单元测试（#571 冲突 8 冻结结论：preflight auto-build 语义翻转）。
 *
 * - dist 存在 → 直接通过；
 * - dist 缺失且 monorepo dev 形态（apps/web 源码在）→ auto-build 分支保留；
 * - dist 缺失且无 apps/web 源码（npm 形态）→ 包损坏：报错 + 重装提示，不现场构建。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureFrontendDist } from '../frontend-dist.js';

let tmp: string;
let frontendDist: string;
let repoDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-frontend-dist-'));
  frontendDist = path.join(tmp, 'pkg/frontend/dist');
  repoDir = path.join(tmp, 'repo');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ensureFrontendDist', () => {
  it('dist/index.html 存在 → ok，不触发构建', () => {
    fs.mkdirSync(frontendDist, { recursive: true });
    fs.writeFileSync(path.join(frontendDist, 'index.html'), '<html></html>');
    let built = false;
    const r = ensureFrontendDist(frontendDist, repoDir, () => { built = true; });
    expect(r.ok).toBe(true);
    expect(r.autoBuilt).toBeFalsy();
    expect(built).toBe(false);
  });

  it('dist 缺失 + apps/web 源码在（monorepo dev）→ 调 builder auto-build', () => {
    fs.mkdirSync(path.join(repoDir, 'apps/web'), { recursive: true });
    let builtWith: string | null = null;
    const r = ensureFrontendDist(frontendDist, repoDir, (webDir) => { builtWith = webDir; });
    expect(r.ok).toBe(true);
    expect(r.autoBuilt).toBe(true);
    expect(builtWith).toBe(path.join(repoDir, 'apps/web'));
  });

  it('auto-build 抛错 → 不 ok，文案含失败原因', () => {
    fs.mkdirSync(path.join(repoDir, 'apps/web'), { recursive: true });
    const r = ensureFrontendDist(frontendDist, repoDir, () => { throw new Error('vite boom'); });
    expect(r.ok).toBe(false);
    expect(r.corrupt).toBeFalsy();
    expect(r.message).toContain('vite boom');
  });

  it('dist 缺失 + 无 apps/web（npm 形态）→ 包损坏：不构建、报错含重装提示', () => {
    let built = false;
    const r = ensureFrontendDist(frontendDist, repoDir, () => { built = true; });
    expect(r.ok).toBe(false);
    expect(r.corrupt).toBe(true);
    expect(built).toBe(false);
    expect(r.message).toMatch(/损坏|corrupt/i);
    expect(r.message).toMatch(/重装|reinstall|npm install/i);
  });
});
