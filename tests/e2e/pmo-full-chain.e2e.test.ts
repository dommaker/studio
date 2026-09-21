/**
 * #106 全链路 e2e 验收（#115 T9，tests/e2e 形态照 mvp-loop.e2e.test.ts）——留存段：
 *
 *   (1a) 建三工程 PMO：gitRepos×3 → 三条交付腿
 *   (1c) 单腿回归：无 gitRepos 的 PMO publish scope 无多腿段
 *
 * 历史段（publish→analysis 开图→逐条 decision 单→spec 成文→TASK 物化→依赖过滤→
 * 逐腿台账）断言的派生链已由 #471（派生链收敛为单 plan WU 一脉会话）退役，
 * 对应用例经 #580 决策删除；现行 plan 链的 e2e 覆盖补足另行立项。
 *
 * 无真实 LLM、不起 agent loop（不建 profile）：agent 侧动作全走公开 API 模拟。
 * 外部副作用零真实发生：频道发送落 tmp FileStore；
 * 交付策略缺省 branch-only 不碰 git merge；三个腿仓库仅作 scope/归属文本比对，不读写。
 *
 * 启动方式同 mvp-loop：子进程跑真实 API（tsx apps/api/src/index.ts），
 * HOME=<tmp>/home 全隔离，PORT 临时空闲端口。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const BOOT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

let tmpRoot = '';
let homeDir = '';
let legRepos: string[] = [];
let port = 0;
let apiBase = '';
let apiProc: ChildProcess | null = null;
let apiLogTail: string[] = [];
let apiLogPath = '';
let apiLogStream: ReturnType<typeof createWriteStream> | null = null;
let lastPollError: string | null = null;

// ─── helpers（形态照 mvp-loop.e2e.test.ts）───

function logApi(line: string): void {
  apiLogTail.push(line);
  if (apiLogTail.length > 300) apiLogTail.shift();
  apiLogStream?.write(line);
  if (process.env.E2E_DEBUG) process.stderr.write(`[api] ${line}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiJson<T = any>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${pathname}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** 轮询直到 condition 返回真值或超时；超时抛出带上下文信息的错误 */
async function pollUntil<T>(label: string, timeoutMs: number, fn: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const out = await fn();
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const tail = apiLogTail.slice(-30).join('');
  lastPollError = `pollUntil("${label}") timed out after ${timeoutMs}ms.${lastErr ? ` last error: ${lastErr}` : ''}\n(full api log: ${apiLogPath})\n--- api log tail ---\n${tail}`;
  throw new Error(lastPollError);
}

/** 建一个本地 git 仓库（腿归属/scope 文本比对用，不做任何写操作） */
function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@studio.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

// ─── server lifecycle ───

async function bootApi(): Promise<void> {
  // 注意：前缀不能是 studio-*（triage-agent 的 resource_critical 动作会 rm -rf /tmp/studio-*）
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'pmo-chain-e2e-'));
  homeDir = path.join(tmpRoot, 'home');
  const studioDir = path.join(homeDir, '.studio');
  mkdirSync(studioDir, { recursive: true });

  apiLogPath = path.join(tmpdir(), `pmo-chain-e2e-api-${process.pid}-${Date.now()}.log`);
  apiLogStream = createWriteStream(apiLogPath);

  // 三条交付腿 = 三个独立 git 仓库
  legRepos = [1, 2, 3].map(i => path.join(tmpRoot, `leg-repo-${i}`));
  for (const dir of legRepos) initGitRepo(dir);
  // REPO_DIR 仍注册一个 VPS workspace（boot ensureLocalWorkspace 契约）
  const workspaceRepo = path.join(tmpRoot, 'workspace-repo');
  initGitRepo(workspaceRepo);

  port = await findFreePort();
  apiBase = `http://127.0.0.1:${port}/api/v1`;

  apiProc = spawn(TSX_BIN, ['apps/api/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      PORT: String(port),
      NODE_ENV: 'test',
      STUDIO_AUTH: 'none',
      STUDIO_CONFIG_DIR: studioDir,
      WORKTREES_DIR: path.join(tmpRoot, 'worktrees'),
      EVENTS_DIR: path.join(tmpRoot, 'events'),
      KNOWLEDGE_DIR: path.join(tmpRoot, 'knowledge'),
      REPO_DIR: workspaceRepo,
      VPS_WORKSPACE_ROOT: workspaceRepo,
      CLOUDFLARED_ENABLED: 'false',
      // 本套件不建 profile、不起 loop（agent 侧动作全走 API 模拟）
      STUDIO_AGENT_LOOP_ENABLED: 'false',
      // PMO gitRepo 白名单（POST /project 校验）：三条腿仓库建在 tmpRoot 下，
      // 不置本环境变量会落在缺省根 /root/projects 之外 → 400 级联全挂（#580）
      PMO_GIT_REPO_ROOTS: tmpRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.stdout?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.stderr?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.on('exit', (code, sig) => logApi(`[e2e] api exited code=${code} sig=${sig}\n`));

  await pollUntil('api readiness', BOOT_TIMEOUT_MS, async () => {
    try {
      const res = await fetch(`${apiBase}/channels`);
      return res.ok ? true : null;
    } catch {
      return null;
    }
  });
}

async function stopApi(): Promise<void> {
  if (!apiProc) return;
  const proc = apiProc;
  apiProc = null;
  proc.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode) break;
    await sleep(200);
  }
  try { proc.kill('SIGKILL'); } catch { /* already dead */ }
}

// ─── the acceptance suite ───

describe('#106 全链路 e2e 留存段：三工程 PMO 建项 + 单腿回归', () => {
  let channelId = '';

  beforeAll(async () => {
    if (!existsSync(TSX_BIN)) throw new Error(`tsx not found at ${TSX_BIN} — run pnpm install`);
    await bootApi();
  }, BOOT_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await stopApi();
    if (apiLogStream) {
      await new Promise((r) => { apiLogStream!.end(r); });
      apiLogStream = null;
    }
    if (apiLogPath && !lastPollError && !process.env.E2E_KEEP_TMP) {
      rmSync(apiLogPath, { force: true });
    } else if (apiLogPath && lastPollError) {
      console.error(`[e2e] api log kept at ${apiLogPath}`);
    }
    if (tmpRoot && !process.env.E2E_KEEP_TMP) {
      rmSync(tmpRoot, { recursive: true, force: true });
    } else if (tmpRoot) {
      console.log(`[e2e] E2E_KEEP_TMP set — keeping ${tmpRoot}`);
    }
  }, 30_000);

  it('(1a) 建三工程 PMO：gitRepos×3 → 三条交付腿', async () => {
    const channel = await apiJson<{ data: any }>('/channels', postJson({ name: `e2e-pmo-${Date.now()}`, type: 'rnd' }));
    channelId = channel.data.id;

    const project = await apiJson<any>('/pmo/project', postJson({
      title: 'e2e 三仓联动',
      requirement: '三个仓库协同交付一个特性',
      gitRepos: legRepos,
    }));
    const projectId = project.id;
    expect(projectId).toBeTruthy();
    expect(project.deliveries.length).toBe(3);
    expect(project.deliveries.map((l: any) => l.gitRepo)).toEqual(legRepos);
    expect(project.gitRepo).toBe(legRepos[0]); // 兼容字段取首工程
    expect(project.map ?? null).toBeNull(); // 未开图 = 非探路型
  });

  it('(1c) 单腿回归：无 gitRepos 的 PMO publish scope 无多腿段（与现状逐字节一致）', async () => {
    const single = await apiJson<any>('/pmo/project', postJson({
      title: 'e2e 单腿回归',
      requirement: '单仓小需求',
      gitRepo: legRepos[0],
    }));
    const fetched = await apiJson<any>(`/pmo/project/${single.id}`);
    expect(fetched.deliveries.length).toBe(1); // 读取时合成单腿（不落盘，零迁移）
    const result = await apiJson<any>(`/pmo/project/${single.id}/publish`, postJson({ channelId }));
    expect(result.workUnit.scope).not.toContain('多交付腿');
  });
});
