/**
 * frontend-dist — 前端产物存在性检查与构建分支（#571 冲突 8 冻结结论）
 *
 * - dist 存在 → 通过；
 * - dist 缺失且 monorepo dev 形态（<repoDir>/apps/web 源码在）→ auto-build 分支保留；
 * - dist 缺失且无 apps/web 源码（npm 形态）→ 包损坏：报错退出并提示重装，不现场构建。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface FrontendDistResult {
  ok: boolean;
  message: string;
  /** 走了 monorepo dev 现场构建分支 */
  autoBuilt?: boolean;
  /** npm 形态包损坏（缺 dist 且无源码可构建） */
  corrupt?: boolean;
}

/** 构建器：在 webDir 执行 vite build 并把产物落到 frontendDistPath（可注入以便测试） */
export type FrontendBuilder = (webDir: string, frontendDistPath: string) => void;

const defaultBuilder: FrontendBuilder = (webDir, frontendDistPath) => {
  execSync('npx vite build', { cwd: webDir, stdio: 'pipe', timeout: 120_000 });
  const srcDist = path.join(webDir, 'dist');
  if (!fs.existsSync(srcDist)) throw new Error('Frontend build produced no dist');
  fs.mkdirSync(path.dirname(frontendDistPath), { recursive: true });
  execSync(`cp -r "${srcDist}/"* "${frontendDistPath}/"`, { stdio: 'pipe' });
};

export function ensureFrontendDist(
  frontendDistPath: string,
  repoDir: string,
  build: FrontendBuilder = defaultBuilder,
): FrontendDistResult {
  const indexHtml = path.join(frontendDistPath, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return { ok: true, message: 'Frontend dist exists' };
  }

  const webDir = path.join(repoDir, 'apps/web');
  if (!fs.existsSync(webDir)) {
    // npm 形态：包内应自带预构建 dist；缺失 = 包损坏，不现场构建（冻结：冲突 8）
    return {
      ok: false,
      corrupt: true,
      message:
        '❌ Frontend dist missing and no apps/web source to build from — '
        + 'the installed package is incomplete/corrupt（包损坏）. '
        + 'Reinstall（重装）: npm install -g @dommaker/studio',
    };
  }

  try {
    build(webDir, frontendDistPath);
    return { ok: true, autoBuilt: true, message: 'Frontend built and deployed' };
  } catch (e: any) {
    return {
      ok: false,
      message: `⚠️ Frontend dist missing and auto-build failed: ${String(e?.message ?? e).slice(0, 100)}`,
    };
  }
}
