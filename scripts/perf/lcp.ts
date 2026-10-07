/**
 * 已认证主应用 LCP 测量（#674）——Playwright chromium + web-vitals，构建产物形态。
 *
 * 链路：隔离 STUDIO_HOME 起 API（STUDIO_AUTH=none + REGISTER_ENABLED=true）
 * → POST /auth/register 造已认证用户（role=User，过 Lurk Wall 进主应用）
 * → vite preview 起 apps/web/dist（生产构建形态，反代 /api 到 API 端口）
 * → chromium 每轮新开 context（localStorage 预置 zustand auth-storage，免 UI 登录仪式）
 * → addInitScript 注入 web-vitals IIFE，onLCP(reportAllChanges) 持续记录
 * → 打开 /（ChannelHomeRedirect → /channels/<id> 主界面），等 URL 跳转 + 稳定后读 LCP。
 *
 * 用法：pnpm perf:lcp [--runs 5] [--out report.json]
 * 前置：apps/web/dist 已构建（pnpm build:web）；本机已装 playwright chromium。
 * stdout 恒输出 markdown 报告；JSON 写 --out（缺省 tmp 文件并打印路径）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { findFreePort, startServer, stopServer, waitReady, removeTempHome, type ServerHandle } from './lib/server.js';
import { percentile } from './lib/stats.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const webDir = join(repoRoot, 'apps', 'web');
const viteCli = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
const webVitalsIife = join(repoRoot, 'node_modules', 'web-vitals', 'dist', 'web-vitals.iife.js');

interface LcpOptions {
  runs: number;
  out?: string;
}

interface LcpRound {
  run: number;
  lcpMs: number;
  url: string;
}

export interface LcpReport {
  date: string;
  commit: string;
  runs: LcpRound[];
  p50Ms: number;
  maxMs: number;
}

export function parseLcpArgs(argv: string[]): LcpOptions {
  const opts: LcpOptions = { runs: 5 };
  let i = 0;
  const next = () => argv[++i];
  for (; i < argv.length; i++) {
    switch (argv[i]) {
      case '--runs': opts.runs = parseInt(next(), 10); break;
      case '--out': opts.out = next(); break;
      default: throw new Error(`未知参数：${argv[i]}`);
    }
  }
  return opts;
}

async function waitHttp200(url: string, proc: ChildProcess, timeoutMs = 60_000, stderr?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const diag = stderr?.() ? `\n${stderr!()}` : '';
      throw new Error(`进程提前退出（code=${proc.exitCode}）${diag}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch {
      // 端口未开，继续轮询
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待 ${url} 200 超时`);
}

/** vite preview 起构建产物；停服用 SIGTERM（同进程，无孙进程） */
async function startPreview(apiPort: number): Promise<{ proc: ChildProcess; port: number; baseUrl: string }> {
  const port = await findFreePort();
  const proc = spawn(process.execPath, [viteCli, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: webDir,
    env: { ...process.env, VITE_DEV_API_PORT: String(apiPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.resume();
  // stderr 留缓冲：提前退出时带诊断
  let stderrBuf = '';
  proc.stderr?.on('data', (chunk) => { stderrBuf += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitHttp200(baseUrl, proc, 60_000, () => stderrBuf);
  return { proc, port, baseUrl };
}

async function registerUser(baseUrl: string): Promise<{ token: string; user: unknown; session: unknown; refreshToken?: string }> {
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'lcp-bench@example.com', password: 'lcp-bench-password', name: 'LCP Bench' }),
  });
  if (!res.ok) throw new Error(`注册失败 ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data: { token: string; refreshToken?: string; user: unknown; session: unknown } };
  return body.data;
}

async function measureRounds(browser: Browser, baseUrl: string, auth: { token: string; user: unknown; session: unknown; refreshToken?: string }, runs: number): Promise<LcpRound[]> {
  const iifeSource = readFileSync(webVitalsIife, 'utf8');
  const storageJson = JSON.stringify({
    state: { token: auth.token, refreshToken: auth.refreshToken ?? null, user: auth.user, session: auth.session, guestId: null },
    version: 0,
  });
  const rounds: LcpRound[] = [];
  for (let i = 1; i <= runs; i++) {
    // 每轮新开 context：无缓存共享、无 Service Worker，接近冷访问
    const context = await browser.newContext();
    try {
      // 页面脚本执行前：预置 zustand auth-storage（免 UI 登录仪式）；
      // web-vitals IIFE 与探针同段注入（playwright 对 init script 的作用域包装不确定，
      // 同段内 var 声明无论包不包都可被后续语句引用——path 分注实测拿不到全局 webVitals）
      await context.addInitScript({
        content: `window.localStorage.setItem('auth-storage', ${JSON.stringify(storageJson)});`,
      });
      await context.addInitScript({
        content: `${iifeSource}\n;window.__lcp = 0; webVitals.onLCP((m) => { window.__lcp = m.value; }, { reportAllChanges: true });`,
      });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      // 主界面 = ChannelHomeRedirect 跳转后的 /channels/<id>
      await page.waitForURL(/\/channels\//, { timeout: 30_000 });
      // 等首屏数据渲染稳定（消息列表等异步填充完成，LCP 候选定格）
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const lcpMs = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);
      rounds.push({ run: i, lcpMs: Math.round(lcpMs), url: page.url() });
    } finally {
      await context.close();
    }
  }
  return rounds;
}

export function renderLcpMarkdown(report: LcpReport): string {
  const lines = [
    '## 已认证主应用 LCP（vite preview 构建产物 + web-vitals）',
    '',
    `commit ${report.commit}，${report.runs.length} 轮（每轮新 browser context，localStorage 预置已认证 User）`,
    '',
    '| 轮次 | LCP | 落点 |',
    '|------|-----|------|',
    ...report.runs.map((r) => `| run${r.run} | ${r.lcpMs} ms | ${new URL(r.url).pathname} |`),
    '',
    `p50 ${report.p50Ms} ms / max ${report.maxMs} ms（目标 < 2000 ms）`,
  ];
  return lines.join('\n');
}

export async function runLcp(opts: LcpOptions): Promise<{ report: LcpReport; markdown: string; jsonPath: string }> {
  if (!existsSync(join(webDir, 'dist', 'assets'))) {
    throw new Error('apps/web/dist 不存在——先跑 pnpm build:web 再测 LCP（测的必须是构建产物形态）。');
  }
  let api: ServerHandle | undefined;
  let preview: { proc: ChildProcess; baseUrl: string } | undefined;
  let browser: Browser | undefined;
  try {
    api = await startServer({ extraEnv: { REGISTER_ENABLED: 'true' } });
    await waitReady(api);
    const auth = await registerUser(api.baseUrl);
    preview = await startPreview(api.port);
    browser = await chromium.launch();
    const rounds = await measureRounds(browser, preview.baseUrl, auth, opts.runs);
    const values = rounds.map((r) => r.lcpMs);
    const report: LcpReport = {
      date: new Date().toISOString().slice(0, 10),
      commit: process.env.GIT_COMMIT ?? 'working-tree',
      runs: rounds,
      p50Ms: percentile(values, 50),
      maxMs: Math.max(...values),
    };
    const markdown = renderLcpMarkdown(report);
    const jsonPath = opts.out ?? join(tmpdir(), `studio-lcp-report-${Date.now()}.json`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    return { report, markdown, jsonPath };
  } finally {
    if (browser) await browser.close();
    if (preview) preview.proc.kill('SIGTERM');
    if (api) {
      await stopServer(api);
      removeTempHome(api.studioHome);
    }
  }
}

// 直接执行（非 import）时跑 CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseLcpArgs(process.argv.slice(2));
  runLcp(opts)
    .then(({ markdown, jsonPath }) => {
      console.log(markdown);
      console.log(`\nJSON 报告：${jsonPath}`);
    })
    .catch((err) => {
      console.error('❌ LCP 测量失败：', err);
      process.exit(1);
    });
}
