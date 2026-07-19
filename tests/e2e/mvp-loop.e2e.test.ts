/**
 * 一期验收总标准（端到端）— docs/plans/2026-07-mvp-fix-plan.md
 *
 * 注册工程 → 创建并激活 kimi/claude 双 profile → 频道 @mention 派发
 * → agent 执行 → 回帖 → NEED_INPUT 提问 → 回复 → COMPLETE → 频道收到结果
 *
 * 无真实 LLM：两个 profile 的 provider 都是 `e2e-fake`（F4 providers.json
 * override，见 beforeAll），二进制为 `node`，指向 fixtures/fake-cli.mjs。
 * fake CLI 输出 stream-json（agent-runner 的 extractResult 只认 stream-json
 * 事件），文本里带 ACTION: NEED_INPUT / ACTION: COMPLETE 协议行
 * （agent-loop.parseAgentOutput 消费）。
 *
 * 启动方式：子进程跑真实 API（tsx apps/api/src/index.ts），env 完全隔离：
 *   HOME=<tmp>/home（~/.studio、providers.json、FileStore、agentHome 全部落在 tmp）
 *   PORT=临时空闲端口  REPO_DIR/VPS_WORKSPACE_ROOT=<tmp git 仓库>
 *   WORKTREES_DIR/EVENTS_DIR/KNOWLEDGE_DIR=<tmp>  CLOUDFLARED_ENABLED=false
 *
 * 已知时序（agent-loop.ts）：NEED_INPUT 后 loop 睡 dynamicInterval=30s 再
 * observe；workunit.created 有 EVENT trigger 即时唤醒。首轮 ~秒级，回复后
 * 最长 ~30s。全程轮询、上限有界。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'fake-cli.mjs');

const RESULT_MARKER = 'E2E_RESULT_OK';
const QUESTION = '方案 A 还是方案 B';
const TASK_TEXT = '实现一个 hello 函数并说明用法';
const REPLY_TEXT = '用方案 A，继续。';

const BOOT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
// 预算按「小内存机器重负载并发时 API 子进程显著变慢」设定（上限值，不影响
// 空闲机器 ~55s 的典型耗时）。注意：整套件是状态依赖的串行验收门，不要在
// 同一台小内存机器上与其他重型套件（tsc-gate、全量单测）并发跑。
const WORKSPACE_TIMEOUT_MS = 240_000; // 覆盖 boot 后 ensureLocalWorkspace 的 fire-and-forget 注册
const CLAIM_TIMEOUT_MS = 90_000;
const BLOCKED_TIMEOUT_MS = 120_000;
// NEED_INPUT 后 loop 固定睡 30s（dynamicInterval），留足余量
const COMPLETE_TIMEOUT_MS = 180_000;

let tmpRoot = '';
let homeDir = '';
let repoDir = '';
let port = 0;
let apiBase = '';
let apiProc: ChildProcess | null = null;
let apiLogTail: string[] = [];
let apiLogPath = '';
let apiLogStream: ReturnType<typeof createWriteStream> | null = null;
let lastPollError: string | null = null;

// ─── helpers ───

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

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase}${pathname}`, init);
}

async function apiJson<T = any>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await api(pathname, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function patchJson(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
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

async function getWorkUnit(id: string): Promise<any> {
  return apiJson(`/workunits/${id}`);
}

async function getChannelMessages(channelId: string): Promise<any[]> {
  const body = await apiJson<{ data: any[] }>(`/channels/${channelId}/messages?limit=100`);
  return body.data;
}

function wuMetadata(wu: any): Record<string, any> {
  if (!wu?.metadata) return {};
  return typeof wu.metadata === 'string' ? JSON.parse(wu.metadata) : wu.metadata;
}

// ─── server lifecycle ───

async function bootApi(): Promise<void> {
  // 注意：前缀不能是 studio-* —— triage-agent 的 resource_critical 修复动作是
  // `rm -rf /tmp/studio-*`（triage-agent.service.ts），内存吃紧时会删掉本套件的
  // 临时目录（本机并发压测时实测踩中）。
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'mvp-e2e-'));
  homeDir = path.join(tmpRoot, 'home');
  repoDir = path.join(tmpRoot, 'repo');
  const studioDir = path.join(homeDir, '.studio');
  mkdirSync(studioDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  // 完整 API 日志落盘（ring buffer 只留尾部，boot 期的关键日志容易被轮询请求冲掉）
  apiLogPath = path.join(tmpdir(), `mvp-e2e-api-${process.pid}-${Date.now()}.log`);
  apiLogStream = createWriteStream(apiLogPath);

  // F4 override: 注册 e2e-fake provider（deep-merge 到内置 registry 之上）
  writeFileSync(path.join(studioDir, 'providers.json'), JSON.stringify({
    providers: {
      'e2e-fake': {
        displayName: 'E2E Fake CLI',
        binaries: ['node'],
        versionArgs: ['--version'],
        healthProbeArgs: ['--version'],
        scanDefault: false,
        spawn: {
          baseArgs: [FAKE_CLI],
          defaultOutputFormat: 'stream-json',
          sessionIdFlag: '--session',
          promptViaStdin: true,
        },
      },
    },
  }, null, 2));

  // 注册工程 = 临时 git 仓库（boot 时 ensureLocalWorkspace 以 REPO_DIR 注册为 VPS workspace）
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'e2e@studio.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'README.md'), '# e2e workspace\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });

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
      REPO_DIR: repoDir,
      VPS_WORKSPACE_ROOT: repoDir,
      CLOUDFLARED_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.stdout?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.stderr?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.on('exit', (code, sig) => logApi(`[e2e] api exited code=${code} sig=${sig}\n`));

  // 等 API 起来
  await pollUntil('api readiness', BOOT_TIMEOUT_MS, async () => {
    try {
      const res = await api('/channels');
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

describe('一期验收：MVP 闭环 e2e（fake provider）', () => {
  let workspaceId = '';
  let channelId = '';
  const profiles: Record<'kimi' | 'claude', any> = { kimi: null, claude: null };
  let workUnitId = '';
  let questionMessage: any = null;

  beforeAll(async () => {
    if (!existsSync(TSX_BIN)) throw new Error(`tsx not found at ${TSX_BIN} — run pnpm install`);
    if (!existsSync(FAKE_CLI)) throw new Error(`fake CLI fixture missing: ${FAKE_CLI}`);
    await bootApi();
  }, BOOT_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await stopApi();
    if (apiLogStream) {
      await new Promise((r) => { apiLogStream!.end(r); });
      apiLogStream = null;
    }
    // 套件全绿时日志文件无用，删掉；有 poll 失败时保留并给出路径（pollUntil
    // 的错误信息里已引用）。E2E_KEEP_TMP=1 时一律保留。
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

  it('(a) 工程已注册：boot 时 REPO_DIR 注册为 VPS workspace', async () => {
    const ws = await pollUntil('workspace registered', WORKSPACE_TIMEOUT_MS, async () => {
      const body = await apiJson<{ data?: any[] } | any[]>('/workspaces');
      const list = Array.isArray(body) ? body : (body.data ?? []);
      return list.find((w: any) => w.workspaceRoot === repoDir) ?? null;
    });
    expect(ws.id).toBeTruthy();
    workspaceId = ws.id;
  });

  it('(c0) 频道创建并绑定默认工程', async () => {
    const created = await apiJson<{ data: any }>('/channels', postJson({ name: `e2e-mvp-${Date.now()}`, type: 'rnd' }));
    channelId = created.data.id;
    expect(channelId).toBeTruthy();

    const patched = await apiJson<{ data: any }>(`/channels/${channelId}`, patchJson({ defaultWorkspaceId: workspaceId }));
    expect(patched.data.defaultWorkspaceId).toBe(workspaceId);
  });

  it('(b) 创建并激活 kimi/claude 双 profile（provider=e2e-fake）→ loop 动态挂载', async () => {
    for (const name of ['kimi', 'claude'] as const) {
      const profile = await apiJson<any>('/agent-profiles', postJson({
        name,
        description: 'task executor (e2e)',
        provider: 'e2e-fake',
        status: 'active',
        channels: [channelId],
      }));
      expect(profile.id).toBeTruthy();
      expect(profile.status).toBe('active');
      profiles[name] = profile;
    }

    // F1/F2：mount 是异步的（health probe → loop start）。probe 失败会写 lastError。
    // 给 mount 一点时间，然后断言两个 profile 都没有启动失败记录。
    await sleep(3_000);
    const list = await apiJson<{ data: any[] }>('/agent-profiles?status=active&limit=100');
    for (const name of ['kimi', 'claude'] as const) {
      const p = list.data.find((x: any) => x.id === profiles[name].id);
      expect(p, `profile ${name} listed`).toBeTruthy();
      expect(p.lastError, `profile ${name} health probe passed`).toBeNull();
    }

    // 两个 profile 加入频道成员
    const members = await apiJson<{ data: { members: string[] } }>(`/channels/${channelId}/members`, patchJson({
      add: [profiles.kimi.id, profiles.claude.id],
    }));
    expect(members.data.members).toEqual(expect.arrayContaining([profiles.kimi.id, profiles.claude.id]));
  });

  it('(d) 人类 @kimi 派发 → WorkUnit 创建并绑定频道默认工程', async () => {
    const msg = await apiJson<{ data: any }>(`/channels/${channelId}/messages`, postJson({
      content: `@kimi ${TASK_TEXT}`,
    }));
    expect(msg.data.authorType).toBe('human');
    expect(msg.data.workUnitId).toBeTruthy();
    workUnitId = msg.data.workUnitId;

    const wu = await getWorkUnit(workUnitId);
    expect(wu.channelId).toBe(channelId);
    expect(wu.workspaceId).toBe(workspaceId); // F6: 频道默认工程绑定
    expect(wu.assigneeId).toBe(profiles.kimi.id); // mention 精确匹配 kimi
    const meta = wuMetadata(wu);
    expect(meta.mentionName).toBe('kimi');
    expect(meta.matched).toBe(true);
  });

  it('(e) WorkUnit 被认领执行，频道出现 agent 回帖', async () => {
    // F1 验收：不重启 API，新 profile 的 loop 认领 WorkUnit。
    // assignee-aware claiming：observe() 按 assigneeId 过滤，@kimi 指派的
    // WorkUnit 只能被 kimi 的 loop 认领（claude 的 loop 会看到但跳过它）。
    await pollUntil('workunit claimed', CLAIM_TIMEOUT_MS, async () => {
      const wu = await getWorkUnit(workUnitId);
      return (wu.status === 'active' || wu.status === 'blocked') ? wu : null;
    });

    const agentMsg = await pollUntil('agent message in channel', CLAIM_TIMEOUT_MS, async () => {
      const messages = await getChannelMessages(channelId);
      return messages.find((m: any) => m.authorType === 'agent' && m.workUnitId === workUnitId) ?? null;
    });
    // @mention 语义：执行者必须是被指派的 profile（kimi），不是 race 胜出的任意 loop
    expect(agentMsg.agentName).toBe('kimi');
  });

  it('(f) NEED_INPUT → WorkUnit blocked + 提问消息进频道', async () => {
    const wu = await pollUntil('workunit blocked (waitingForInput)', BLOCKED_TIMEOUT_MS, async () => {
      const w = await getWorkUnit(workUnitId);
      return (w.status === 'blocked' && wuMetadata(w).waitingForInput) ? w : null;
    });
    expect(wuMetadata(wu).waitingQuestion).toContain(QUESTION);

    questionMessage = await pollUntil('question message posted', BLOCKED_TIMEOUT_MS, async () => {
      const messages = await getChannelMessages(channelId);
      return messages.find((m: any) =>
        m.authorType === 'agent' && m.workUnitId === workUnitId &&
        m.content.includes('需要输入') && m.content.includes(QUESTION)) ?? null;
    });
    expect(questionMessage.id).toBeTruthy();
  });

  it('(g) 人类在线程中回复 → WorkUnit 解除挂起', async () => {
    const reply = await apiJson<{ data: any }>(`/channels/${channelId}/messages`, postJson({
      content: REPLY_TEXT,
      replyToId: questionMessage.id,
    }));
    expect(reply.data.authorType).toBe('human');
    expect(reply.data.workUnitId).toBe(workUnitId); // 线程回复继承 workUnitId

    // resume 与 loop 下一步之间只隔 ≤30s 的 need_input sleep，active 窗口可能
    // 一闪而过（下一步 COMPLETE 立刻转 in_review）——放宽：接受 active / in_review。
    const wu = await pollUntil('workunit resumed', BLOCKED_TIMEOUT_MS, async () => {
      const w = await getWorkUnit(workUnitId);
      const meta = wuMetadata(w);
      const resumed = (w.status === 'active' && Array.isArray(meta.pendingReplies)) || w.status === 'in_review';
      return resumed ? w : null;
    });
    const meta = wuMetadata(wu);
    if (Array.isArray(meta.pendingReplies)) {
      expect(meta.pendingReplies.join('\n')).toContain(REPLY_TEXT);
    }
  });

  it('(h) COMPLETE → WorkUnit in_review + 结果消息进频道（含 F6 cwd 证据）', async () => {
    // 状态机无 "completed" 状态：agent 输出 COMPLETE → active → in_review
    // （VALID_TRANSITIONS, workunit.service.ts）；in_review 即 agent 侧终态。
    await pollUntil('workunit in_review (COMPLETE)', COMPLETE_TIMEOUT_MS, async () => {
      const w = await getWorkUnit(workUnitId);
      return w.status === 'in_review' ? w : null;
    });

    const resultMsg = await pollUntil('result message in channel', COMPLETE_TIMEOUT_MS, async () => {
      const messages = await getChannelMessages(channelId);
      return messages.find((m: any) =>
        m.authorType === 'agent' && m.workUnitId === workUnitId && m.content.includes(RESULT_MARKER)) ?? null;
    });
    // F6 验收：CLI 实际在绑定工程的根目录执行（fixture 把 process.cwd() 写进结果）
    expect(resultMsg.content).toContain(`cwd=${repoDir}`);

    // 完整消息链 sanity check：人类任务 → agent 提问 → 人类回复 → agent 结果
    const messages = await getChannelMessages(channelId);
    const ours = messages.filter((m: any) => m.workUnitId === workUnitId);
    expect(ours.some((m: any) => m.authorType === 'human' && m.content.includes(TASK_TEXT))).toBe(true);
    expect(ours.some((m: any) => m.authorType === 'human' && m.content.includes(REPLY_TEXT))).toBe(true);
    expect(ours.filter((m: any) => m.authorType === 'agent').length).toBeGreaterThanOrEqual(2);
  });
});
