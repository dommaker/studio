// ── studio run web：npm 本地形态一体起服务总入口（#571）──
// API + 托管已构建 web dist + 首启检测块 + 端口动态顺延；前台进程，Ctrl-C 即停
//（SIGINT → index.ts shutdown 处理器）。studio up 原样保留（服务器形态）。
//
// 数据区迁移钩子（#572 迁移框架落地后挂入）：接入点在本函数 PREFLIGHT 之前、
// 首启检测块之后——迁移失败 = 拒绝启动（契约 §5）。
//
// frontend dist 路径约定与 app.ts:133 一致（<模块目录上溯>/frontend/dist）：
// src/tsc 形态本文件在 .../cli/ 下 → 上溯两级 = apps/api/frontend/dist；
// esbuild bundle 形态 cli/ 被拍平，bundle 直接在 .../dist/ → 上溯一级 = dist-npm/apps/api/frontend/dist。
// tsx 直跑 src 形态下 web 静态托管本就不工作（dev 走独立 vite），此处不另开分支。

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STUDIO_DIR } from './shared.js';
import { ensureDataDirs, ensureDaemonSecrets, probeStorageWritable } from './bootstrap.js';
import { scanAllProviders } from '../daemon/cli-scanner.js';
import { buildFirstRunPanel } from './first-run-panel.js';
import { parsePortFlag, resolvePort, explicitPortFromEnv } from './port-probe.js';
import { ensureFrontendDist } from '../utils/frontend-dist.js';
import { resolveListenHost } from '../utils/listen-host.js';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

/** frontend dist 目录：cli/ 形态上溯两级，bundle 拍平形态上溯一级（见文件头注释） */
export function resolveFrontendDistFrom(cliDir: string): string {
  const up = path.basename(cliDir) === 'cli' ? 2 : 1;
  return path.resolve(cliDir, ...Array(up).fill('..'), 'frontend', 'dist');
}

/** 从 CLI 所在位置向上找含 apps/web 源码的 monorepo 根（dev 形态 auto-build 分支用） */
export function findMonorepoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    if (fs.existsSync(path.join(dir, 'apps/web', 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export async function studioRunWeb(rawArgs: string[]): Promise<void> {
  const { port: flagPort } = parsePortFlag(rawArgs);

  // 1. 数据目录 + 密钥自举（必须先于任何 .env/配置加载，占位值不得覆盖已生成密钥）
  ensureDataDirs(STUDIO_DIR);
  const daemonDir = path.join(STUDIO_DIR, '.daemon');
  ensureDaemonSecrets(daemonDir);

  // 2. 默认环境变量（不覆盖显式配置）
  if (!process.env.ANALYST_DIR) process.env.ANALYST_DIR = path.join(STUDIO_DIR, '.analyst');
  if (!process.env.DAEMON_DIR) process.env.DAEMON_DIR = daemonDir;
  if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = path.join(STUDIO_DIR, 'worktrees');
  // KNOWLEDGE_DIR 缺省由 index.ts 经 utils/runtime-paths 归数据根（harness-knowledge）

  // 3. 端口：显式（--port / PORT）占用即拒启；缺省 3001 起动态顺延（上限 +100）
  const host = resolveListenHost(process.env);
  const explicitPort = explicitPortFromEnv(flagPort);
  const resolved = await resolvePort({ host, explicitPort });

  // 4. 首启检测块（Node 版本 / agent CLI 探测 / 数据根 / 实际监听地址；缺 CLI 不阻断）
  const providers = scanAllProviders();
  console.log(buildFirstRunPanel({
    nodeVersion: process.version,
    minNodeMajor: 20,
    providers,
    dataRoot: STUDIO_DIR,
    listenHost: host,
    listenPort: resolved.port,
    shiftedFrom: resolved.shiftedFrom,
  }));

  // 5. Preflight：数据根可写 + 前端产物（npm 形态缺 dist = 包损坏报错，不现场构建）
  try {
    probeStorageWritable(path.join(STUDIO_DIR, 'data'));
  } catch (e: any) {
    console.error(`❌ Data dir not writable: ${path.join(STUDIO_DIR, 'data')} (${e.message})`);
    process.exit(1);
  }
  const frontendDist = resolveFrontendDistFrom(CLI_DIR);
  const frontend = ensureFrontendDist(frontendDist, findMonorepoRoot(CLI_DIR) ?? CLI_DIR);
  if (!frontend.ok) {
    console.error(frontend.message);
    if (frontend.corrupt) process.exit(1);
  }

  // 6. 首启默认数据（默认频道 + admin，幂等）
  try {
    const { createOpsService } = await import('../modules/agents/ops/ops.service.js');
    const defaults = await createOpsService(resolved.port).ensureDefaults();
    console.log(`Defaults: ${defaults.channels} channels, admin ${defaults.admin ? 'exists' : 'created'}`);
  } catch (e: any) {
    console.error('Defaults init failed (non-blocking):', String(e?.message ?? e).slice(0, 200));
  }

  // 7. 起服务（index.ts 于 import 时自启；SIGINT/SIGTERM 走其 shutdown 处理器）
  process.env.PORT = String(resolved.port);
  console.log('Starting server...');
  await import('../index.js');
}
