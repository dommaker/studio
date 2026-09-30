// ── 配置加载（无论怎么启动都会执行）──
// P2-a：自 apps/api/src/index.ts 拆出。PORT/HOST 解析 → 软护栏 warning → loadConfig
// 的顺序与原 index.ts 模块体一致（loadConfig 从 STUDIO_CONFIG_DIR 注入的 env 不影响
// PORT/HOST 解析——原文件即此口径，保持零漂移）。
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';
import { studioDir as resolveStudioDir, warnIfNonProdUsesProdRoot } from '@dommaker/studio-shared/studio-dir';
import { resolveListenHost } from '../utils/listen-host.js';

let PORT: string | number = 3001;
let HOST = '127.0.0.1';

function loadConfig(): void {
  const configDir = process.env.STUDIO_CONFIG_DIR;
  if (!configDir) {
    // Fallback: STUDIO_HOME（缺省 ~/.studio）defaults
    const studioDir = resolveStudioDir();
    if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = path.join(studioDir, 'worktrees');
    // events/ 目录双口径已收编（#571 / 契约 §8）：统一事件流正本在 logs/，不再注入 EVENTS_DIR
    return;
  }

  // Load .env file from config directory
  const envPath = configDir.endsWith('.env') ? configDir : path.join(configDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    logger.info('Config loaded', { source: envPath });
  }
}

export function initConfig(): void {
  PORT = process.env.PORT || 3001;
  // 2026-08-25 安全收口：默认只绑回环（服务器模式经 nginx 同机反代，npm 自托管
  // 模式只允许本机）；none 免登录模式绑非回环会被 resolveListenHost 拒启。
  HOST = resolveListenHost(process.env);
  // 软护栏：非 production 指向生产缺省根时启动落 warning（幂等，显式触发不靠间接 import 链）
  warnIfNonProdUsesProdRoot();
  loadConfig();
}

export function getPort(): string | number {
  return PORT;
}

export function getHost(): string {
  return HOST;
}
