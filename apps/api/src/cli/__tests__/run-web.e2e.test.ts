/**
 * studio run web 活端口 e2e（#571）— 默认 skip，STUDIO_E2E_LIVE=1 才跑（#219 门禁同构）。
 *
 * 全链路验证：tsx 起 CLI → 首启检测块输出 → 显式 --port 命中 → health 200 →
 * web 静态产物可访问 → SIGINT 优雅退出（前台进程 Ctrl-C 即停）。
 *
 * 注：tsx 形态下 app.ts/本模块的 frontend dist 解析到 apps/api/frontend/dist
 * （bundle/tsc 形态为 <pkg>/apps/api/frontend/dist，路径约定同构），测试在该位置
 * 放最小 index.html 避开 auto-build，teardown 清除。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const LIVE = process.env.STUDIO_E2E_LIVE === '1';
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// app.ts 的 frontend dist 落点（__dirname/../frontend/dist，全形态同构）
const STUB_FRONTEND_DIST = path.join(API_DIR, 'frontend', 'dist');

async function grabFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe.skipIf(!LIVE)('studio run web e2e', () => {
  let tmpHome: string;
  let port: number;
  let child: ChildProcess;
  let stdoutBuf = '';
  let stubbedFrontend = false;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-run-web-e2e-'));
    port = await grabFreePort();
    if (!fs.existsSync(path.join(STUB_FRONTEND_DIST, 'index.html'))) {
      fs.mkdirSync(STUB_FRONTEND_DIST, { recursive: true });
      fs.writeFileSync(path.join(STUB_FRONTEND_DIST, 'index.html'), '<html><body>studio-e2e</body></html>');
      stubbedFrontend = true;
    }

    // node --import tsx 直起（不经 npx 包装），SIGINT 才能直达服务器进程；入口用绝对路径
    child = spawn(process.execPath, ['--import', 'tsx', path.join(API_DIR, 'src', 'cli', 'studio-cli.ts'), 'run', 'web', '--port', String(port)], {
      cwd: API_DIR,
      env: {
        ...process.env,
        STUDIO_HOME: tmpHome,
        STUDIO_AUTH: 'none',
        NODE_ENV: 'test',
        CLOUDFLARED_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr?.on('data', (d) => { stdoutBuf += d.toString(); });

    // 等 health 就绪（首启含 secrets/defaults/harness 自举，放宽到 90s）
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready */ }
      if (Date.now() > deadline) throw new Error(`server did not become ready.\n--- output ---\n${stdoutBuf}`);
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}).\n--- output ---\n${stdoutBuf}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 120_000);

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (stubbedFrontend) fs.rmSync(path.join(API_DIR, 'frontend'), { recursive: true, force: true });
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('首启检测块打印（数据根 / 监听地址 / Node 版本）', () => {
    expect(stdoutBuf).toContain('environment check');
    expect(stdoutBuf).toContain(tmpHome);
    expect(stdoutBuf).toContain(`127.0.0.1:${port}`);
    expect(stdoutBuf).toContain(process.version);
  });

  it('health endpoint 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
  });

  it('web 静态产物可访问（SPA index）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('studio-e2e');
  });

  it('SIGINT 优雅退出（Ctrl-C 即停）', async () => {
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 15_000);
      child.once('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).not.toBeNull();
  }, 20_000);
});
