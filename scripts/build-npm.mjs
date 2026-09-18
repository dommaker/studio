#!/usr/bin/env node
/**
 * build-npm — npm 单包形态构建（#571 / docs/plans/2026-09-npm-local-form.md）
 *
 * 产物布局（全部落在 dist-npm/，由根 package.json files 白名单随包分发）：
 *   dist-npm/apps/api/dist/studio-cli.mjs   esbuild 单文件 bundle（CLI + server 全链路；
 *                                           workspace 包代码内嵌，npm 依赖保持 external）
 *   dist-npm/apps/api/frontend/dist/        apps/web 预构建产物（app.ts 路径约定 __dirname/../frontend/dist）
 *   dist-npm/apps/api/skills/               内置 skill 库正本（studio-skill seed.ts defaultSourceDir
 *                                           上溯一级到包根的约定 → bundle 形态即 <bundle>/../skills）
 *
 * 收口语义：
 * - externals = 根 package.json dependencies（单一事实源），metafile 校验：
 *   任何被 bundle 的 node_modules 文件 = 依赖漏声明，构建失败（防静默内嵌第三方包）；
 * - 包内 dist 缺失 = 包损坏（运行时 preflight 语义，见 utils/frontend-dist.ts），本脚本不产出即失败。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-npm');
const API_OUT = path.join(OUT, 'apps', 'api');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// 0. 清场
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(API_OUT, { recursive: true });

// 1. web 前端预构建（vite）→ dist-npm/apps/api/frontend/dist
console.log('[build-npm] building web frontend...');
execSync('pnpm --filter @dommaker/studio-web build', { cwd: ROOT, stdio: 'inherit' });
const webDist = path.join(ROOT, 'apps', 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  throw new Error(`[build-npm] web build produced no dist/index.html at ${webDist}`);
}
copyDir(webDist, path.join(API_OUT, 'frontend', 'dist'));

// 2. esbuild bundle（CLI 入口；server index.ts 经动态 import 一并内嵌）
console.log('[build-npm] bundling CLI + server...');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const externals = Object.keys(rootPkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);

const banner = [
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
].join('\n');

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'apps', 'api', 'src', 'cli', 'studio-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(API_OUT, 'dist', 'studio-cli.mjs'),
  banner: { js: banner },
  external: externals,
  metafile: true,
  logLevel: 'warning',
});

// 2b. 依赖收口校验：bundle 不得内嵌任何 node_modules 文件（漏声明的依赖会静默内嵌）
const embedded = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules'));
if (embedded.length > 0) {
  throw new Error(
    '[build-npm] third-party modules embedded in bundle (declare them in root package.json dependencies):\n'
    + embedded.map((p) => `  - ${p}`).join('\n'),
  );
}

// 3. 内置 skill 库正本（seed 路径约定：bundle 所在 dist/ 上溯一级 = apps/api/skills）
const skillsSrc = path.join(ROOT, 'packages', 'studio-skill', 'skills');
if (!fs.existsSync(skillsSrc)) throw new Error(`[build-npm] builtin skills source missing: ${skillsSrc}`);
copyDir(skillsSrc, path.join(API_OUT, 'skills'));

// 4. 体积报告
const bundleSize = fs.statSync(path.join(API_OUT, 'dist', 'studio-cli.mjs')).size;
const dirSize = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  }
  return total;
};
console.log(`[build-npm] done:
  bundle:   ${(bundleSize / 1024 / 1024).toFixed(2)} MB (dist-npm/apps/api/dist/studio-cli.mjs)
  frontend: ${(dirSize(path.join(API_OUT, 'frontend', 'dist')) / 1024).toFixed(0)} KB
  skills:   ${(dirSize(path.join(API_OUT, 'skills')) / 1024).toFixed(0)} KB`);
