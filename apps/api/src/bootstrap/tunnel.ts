// ── Cloudflared Tunnel — 自动重启守护 + URL 变化通知 ──
// P2-a：自 apps/api/src/index.ts 拆出。进程句柄收进模块态，stopTunnel 供优雅关闭调用。
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { logger } from '@dommaker/studio-shared';
import { tunnelUrlFile } from '../utils/runtime-paths.js';
import { isCloudflaredEnabled } from '../utils/cloudflared.js';

let cloudflaredProc: ChildProcess | null = null;
let lastTunnelUrl = '';

const notifyTunnelUrl = async (url: string) => {
  // 写文件，方便随时查看
  try { fs.writeFileSync(tunnelUrlFile(), url, 'utf-8'); } catch {}
  // 显著日志
  logger.info('='.repeat(70));
  logger.info(`🔗 DISCORD INTERACTIONS ENDPOINT URL: ${url}/api/v1/discord/interactions`);
  logger.info('='.repeat(70));
  // Discord 通知（复用 discordNotifier）
  try {
    const { discordNotifier } = await import('../utils/discord-notifier.js');
    await discordNotifier.sendText(
      '🔗 Tunnel URL 已更新',
      `新的 Interactions Endpoint URL:\n\`\`\`\n${url}/api/v1/discord/interactions\n\`\`\`\n请到 Discord Developer Portal 更新。`
    );
  } catch (e) {
    logger.error('[Cloudflared] Failed to send Discord tunnel notification', { error: String(e) });
  }
};

const startCloudflared = (port: string | number) => {
  try {
    cloudflaredProc = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${port}`,
      '--no-autoupdate',
    ], { stdio: 'pipe' });
    // 累积 stdout 行来解析 URL
    let stdoutBuf = '';
    cloudflaredProc.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      for (const line of lines) {
        if (line.includes('trycloudflare.com')) {
          const m = line.match(/([a-z0-9-]+\.trycloudflare\.com)/);
          if (m) {
            const url = `https://${m[1]}`;
            if (url !== lastTunnelUrl) {
              lastTunnelUrl = url;
              notifyTunnelUrl(url);
            }
          }
        }
      }
      // 只保留最后一行未完成的部分
      if (!stdoutBuf.endsWith('\n')) stdoutBuf = lines[lines.length - 1] || '';
      else stdoutBuf = '';
    });
    cloudflaredProc.stderr?.on('data', (d: Buffer) => logger.warn(`[Cloudflared] ${d.toString().trim()}`));
    cloudflaredProc.on('exit', (code, sig) => {
      logger.warn(`[Cloudflared] Exited (code=${code}, sig=${sig}), restarting in 5s...`);
      cloudflaredProc = null;
      setTimeout(() => startCloudflared(port), 5000);
    });
  } catch {
    logger.warn('[Cloudflared] Not available, Discord tunnel disabled');
  }
};

// #571 冲突 5 冻结：外联隧道默认关，仅显式 CLOUDFLARED_ENABLED=true 拉起
export function startTunnelIfEnabled(port: string | number): void {
  if (isCloudflaredEnabled()) {
    startCloudflared(port);
  } else {
    logger.info('[Cloudflared] Disabled (default off; set CLOUDFLARED_ENABLED=true to enable)');
  }
}

export function stopTunnel(): void {
  if (cloudflaredProc) { cloudflaredProc.kill(); cloudflaredProc = null; }
}
