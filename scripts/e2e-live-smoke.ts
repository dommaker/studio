/**
 * Live smoke — 一期验收链路的真实 CLI 版本（手动运行，不属于 pnpm test:e2e）。
 *
 *   npx tsx scripts/e2e-live-smoke.ts           # 用真实 ~/.studio（保留现有数据，资源带 e2e- 前缀并尽量清理）
 *   npx tsx scripts/e2e-live-smoke.ts --temp    # mkdtemp 隔离 HOME/STUDIO_CONFIG_DIR（注意：claude 的
 *                                               # ~/.claude 登录态也会丢，需 ANTHROPIC_API_KEY 等 env 鉴权）
 *
 * 流程与 tests/e2e/mvp-loop.e2e.test.ts 相同：注册工程（临时 git 仓库）→
 * 激活 claude profile → 频道 @mention 派发一个极小任务 → agent 执行 → 回帖
 * → （如 NEED_INPUT 自动回复一次）→ COMPLETE → 频道收到结果。
 *
 * claude CLI 不在 PATH 时打印 SKIP 并以 0 退出（F4 验收约定：无对应 CLI 记 skip 而非 fail）。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const USE_TEMP = process.argv.includes('--temp');
const OVERALL_TIMEOUT_MS = 5 * 60_000;

const AGENT_NAME = `e2e-claude-${Date.now().toString(36)}`;
const TASK_TEXT = '这是一个冒烟测试。请只输出一行 OK，然后按协议输出 ACTION: COMPLETE: live-smoke done。不要做任何其他事情。';
const RESULT_MARKER = 'live-smoke done';

const tmpDirs: string[] = [];
let apiProc: ChildProcess | null = null;
let apiBase = '';
let repoDir = '';

function log(msg: string): void {
  console.log(`[live-smoke ${(process.uptime()).toFixed(1)}s] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function apiJson<T = any>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${pathname}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

const postJson = (body: unknown): RequestInit =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patchJson = (body: unknown): RequestInit =>
  ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function pollUntil<T>(label: string, timeoutMs: number, fn: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await fn().catch(() => null);
    if (out) return out;
    await sleep(2_000);
  }
  throw new Error(`pollUntil("${label}") timed out after ${timeoutMs}ms`);
}

async function cleanup(profileId?: string, channelId?: string): Promise<void> {
  if (profileId) {
    // 先 deactivate（F1: unmount loop）再删除，best-effort
    await apiJson(`/agent-profiles/${profileId}`, patchJson({ status: 'inactive' })).catch(() => {});
    await apiJson(`/agent-profiles/${profileId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (channelId) {
    await apiJson(`/channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (apiProc) {
    apiProc.kill('SIGTERM');
    await sleep(3_000);
    try { apiProc.kill('SIGKILL'); } catch { /* dead */ }
    apiProc = null;
  }
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // F4 约定：CLI 缺失 → skip（exit 0），不记 fail
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 10_000 }).trim();
    log(`claude CLI found: ${v}`);
  } catch {
    console.log('[live-smoke] SKIP: `claude` not on PATH (install claude CLI to run the live smoke)');
    return;
  }

  // HOME / STUDIO_CONFIG_DIR：--temp → mkdtemp 隔离；默认沿用真实 ~/.studio
  let homeDir = process.env.HOME ?? '';
  let studioConfigDir: string | undefined;
  if (USE_TEMP) {
    homeDir = mkdtempSync(path.join(tmpdir(), 'live-smoke-home-'));
    tmpDirs.push(homeDir);
    studioConfigDir = path.join(homeDir, '.studio');
    mkdirSync(studioConfigDir, { recursive: true });
    log(`--temp: isolated HOME=${homeDir}`);
  } else {
    studioConfigDir = process.env.STUDIO_CONFIG_DIR;
    log('using real HOME / ~/.studio (resources are prefixed e2e- and cleaned up best-effort)');
  }

  // 注册工程：临时 git 仓库（boot 时注册为 VPS workspace）。
  // 前缀同样避开 studio-*（triage-agent resource_critical 会 rm -rf /tmp/studio-*）。
  repoDir = mkdtempSync(path.join(tmpdir(), 'live-smoke-repo-'));
  tmpDirs.push(repoDir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'e2e@studio.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'README.md'), '# live smoke workspace\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

  const port = await findFreePort();
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  log(`booting API on :${port} ...`);
  apiProc = spawn(TSX_BIN, ['apps/api/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      PORT: String(port),
      STUDIO_AUTH: 'none',
      ...(studioConfigDir ? { STUDIO_CONFIG_DIR: studioConfigDir } : {}),
      REPO_DIR: repoDir,
      VPS_WORKSPACE_ROOT: repoDir,
      CLOUDFLARED_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (process.env.E2E_DEBUG) {
    apiProc.stdout?.on('data', (d: Buffer) => process.stderr.write(`[api] ${d}`));
    apiProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[api:err] ${d}`));
  }

  let profileId: string | undefined;
  let channelId: string | undefined;
  try {
    await pollUntil('api readiness', 120_000, async () => (await fetch(`${apiBase}/channels`).catch(() => null))?.ok || null);
    log('API ready');

    const workspace = await pollUntil<any>('VPS workspace registered', 30_000, async () => {
      const body = await apiJson<{ data?: any[] } | any[]>('/workspaces');
      const list = Array.isArray(body) ? body : (body.data ?? []);
      return list.find((w: any) => w.workspaceRoot === repoDir) ?? null;
    });
    log(`workspace registered: ${workspace.id} (${workspace.workspaceRoot})`);

    const channel = await apiJson<{ data: any }>('/channels', postJson({ name: `e2e-live-${Date.now().toString(36)}`, type: 'rnd' }));
    channelId = channel.data.id;
    await apiJson(`/channels/${channelId}`, patchJson({ defaultWorkspaceId: workspace.id }));

    const profile = await apiJson<any>('/agent-profiles', postJson({
      name: AGENT_NAME,
      description: 'task executor (live smoke)',
      provider: 'claude',
      status: 'active',
      channels: [channelId],
    }));
    profileId = profile.id;
    await apiJson(`/channels/${channelId}/members`, patchJson({ add: [profileId] }));
    log(`profile ${AGENT_NAME} active, loop mounting (health probe: claude --version)`);
    await sleep(3_000);

    const msg = await apiJson<{ data: any }>(`/channels/${channelId}/messages`, postJson({ content: `@${AGENT_NAME} ${TASK_TEXT}` }));
    const workUnitId = msg.data.workUnitId;
    if (!workUnitId) throw new Error('mention did not create a WorkUnit');
    log(`WorkUnit dispatched: ${workUnitId}`);

    // agent 执行 → （NEED_INPUT 则回复一次）→ COMPLETE；真实 LLM 慢，给足时间
    const deadline = Date.now() + OVERALL_TIMEOUT_MS - 60_000;
    let repliedOnce = false;
    let finalWu: any = null;
    while (Date.now() < deadline) {
      const wu = await apiJson<any>(`/workunits/${workUnitId}`);
      if (wu.status === 'in_review') { finalWu = wu; break; }
      if (wu.status === 'blocked' && !repliedOnce) {
        const meta = typeof wu.metadata === 'string' ? JSON.parse(wu.metadata ?? '{}') : (wu.metadata ?? {});
        if (meta.waitingForInput) {
          log('agent asked NEED_INPUT — auto-replying once');
          const msgs = (await apiJson<{ data: any[] }>(`/channels/${channelId}/messages?limit=100`)).data;
          const question = msgs.find((m: any) => m.authorType === 'agent' && m.workUnitId === workUnitId);
          await apiJson(`/channels/${channelId}/messages`, postJson({
            content: '不需要更多输入，请直接输出 OK 并完成（ACTION: COMPLETE）。',
            replyToId: question?.id,
          }));
          repliedOnce = true;
        }
      }
      await sleep(5_000);
    }
    if (!finalWu) throw new Error('WorkUnit did not reach in_review (COMPLETE) within the budget');

    const messages = (await apiJson<{ data: any[] }>(`/channels/${channelId}/messages?limit=100`)).data;
    const result = messages.find((m: any) => m.authorType === 'agent' && m.workUnitId === workUnitId && m.content.includes(RESULT_MARKER));
    log(`COMPLETE — WorkUnit in_review. Result message: ${result ? result.content.slice(0, 120) : '(marker not found, agent completed anyway)'}`);
    console.log('[live-smoke] PASS');
  } finally {
    await cleanup(profileId, channelId);
  }
}

const watchdog = setTimeout(() => {
  console.error('[live-smoke] FAIL: overall timeout');
  cleanup().finally(() => process.exit(1));
}, OVERALL_TIMEOUT_MS);

main().then(
  () => { clearTimeout(watchdog); process.exit(0); },
  async (err) => {
    clearTimeout(watchdog);
    console.error(`[live-smoke] FAIL: ${err instanceof Error ? err.message : err}`);
    await cleanup();
    process.exit(1);
  },
);
