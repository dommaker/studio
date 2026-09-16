/**
 * run-web.ts 单元测试（#571）：frontend dist 路径解析与 monorepo 根探测。
 * 全链路（起服务/首启面板/SIGINT）由同目录 run-web.e2e.test.ts（STUDIO_E2E_LIVE=1）覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveFrontendDistFrom, findMonorepoRoot } from '../run-web.js';

describe('resolveFrontendDistFrom', () => {
  it('src/tsc 形态（.../cli/ 下）→ 上溯两级', () => {
    expect(resolveFrontendDistFrom('/pkg/apps/api/src/cli'))
      .toBe('/pkg/apps/api/frontend/dist');
    expect(resolveFrontendDistFrom('/pkg/apps/api/dist/cli'))
      .toBe('/pkg/apps/api/frontend/dist');
  });

  it('bundle 拍平形态（.../dist/ 直接落 bundle）→ 上溯一级', () => {
    expect(resolveFrontendDistFrom('/pkg/dist-npm/apps/api/dist'))
      .toBe('/pkg/dist-npm/apps/api/frontend/dist');
  });
});

describe('findMonorepoRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-run-web-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('向上找到含 apps/web/package.json 的根', () => {
    const root = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(root, 'apps/web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/web', 'package.json'), '{}');
    const deep = path.join(root, 'apps/api/dist/cli');
    fs.mkdirSync(deep, { recursive: true });
    expect(findMonorepoRoot(deep)).toBe(root);
  });

  it('无 apps/web（npm 形态）→ null（触发包损坏分支而非 auto-build）', () => {
    const isolated = path.join(tmp, 'prefix/lib/node_modules/@dommaker/studio/dist-npm/apps/api/dist');
    fs.mkdirSync(isolated, { recursive: true });
    expect(findMonorepoRoot(isolated)).toBeNull();
  });
});
