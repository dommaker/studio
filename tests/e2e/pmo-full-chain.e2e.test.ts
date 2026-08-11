/**
 * #106 全链路 e2e 验收（#115 T9，tests/e2e 形态照 mvp-loop.e2e.test.ts）：
 *
 *   三工程 PMO（gitRepos×3）→ publish 发频道建分析单（多腿只读 scope）
 *   → 人工开图（l3 确认文本含 DESTINATION:/FOG:）→ 地图初始化 + 逐条建 decision 单
 *   → 决策认领/线程讨论（NEED_INPUT 往返）→ 人工填结论点通过 → decisions 追加 + fog resolved
 *   → 雾全清自动建 spec 成文单 → 交稿通过（l3 含 TASK 物化清单）→ 任务单批量物化
 *     （ac/blockedBy/腿归属齐全）
 *   → 依赖过滤（blockedBy 未了结 claimable=false，了结后 true）
 *   → 逐腿台账独立演进 + 单腿回归（scope 无多腿段）
 *
 * 覆盖 #106 验收标准 1-6 的可测部分；标准 7（地图页渲染）由 #114 组件测试覆盖，
 * 本套件验证 API 数据齐备（map/deliveries/legs/claimable）。
 *
 * 无真实 LLM、不起 agent loop（不建 profile）：agent 侧动作（认领/状态迁移/人工确认）
 * 全部走公开 API 模拟。外部副作用零真实发生：频道发送落 tmp FileStore；
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
// 事件订阅器是 fire-and-forget（map-opening/decision-resolution/spec-materialization 链式
// 落盘），轮询上限留足小内存机器余量
const MECHANISM_TIMEOUT_MS = 60_000;

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

async function getWorkUnit(id: string): Promise<any> {
  return apiJson(`/workunits/${id}`);
}

async function transitionWu(id: string, status: string): Promise<any> {
  return apiJson(`/workunits/${id}/status`, postJson({ status }));
}

/** 人工确认通过（l3 台账，summary = 人填的确认文本） */
async function reviewPass(id: string, summary?: string): Promise<any> {
  return apiJson(`/workunits/${id}/review-passed`, postJson(summary !== undefined ? { summary } : {}));
}

/**
 * 完结一个代码类 WU（task）：ReviewDispatcher 会在父 WU 进 in_review 时派生
 * 未指派 review 子单（真实链路里由评审 loop 认领完结；本套件无 loop，API 模拟）。
 * 子单不完结会一直占着在途名额（逐腿台账全完结判定），故先完结子单再人工通过父单。
 * 子单无 reviewReport → 路径 B 不自动翻转父单（频道转人工），父单靠 reviewPassed 收尾。
 */
async function completeCodeWu(id: string): Promise<void> {
  await transitionWu(id, 'active');
  await transitionWu(id, 'in_review');
  const reviewChild = await pollUntil(`review child for ${id}`, MECHANISM_TIMEOUT_MS, async () => {
    const list = await listWorkUnits(`type=review&parentId=${id}&limit=10`);
    return list.find((w: any) => w.status !== 'done' && w.status !== 'closed') ?? null;
  });
  await transitionWu(reviewChild.id, 'active');
  await transitionWu(reviewChild.id, 'in_review');
  await reviewPass(reviewChild.id);
  await reviewPass(id);
}

function wuMetadata(wu: any): Record<string, any> {
  if (!wu?.metadata) return {};
  return typeof wu.metadata === 'string' ? JSON.parse(wu.metadata) : wu.metadata;
}

async function listWorkUnits(query: string): Promise<any[]> {
  const body = await apiJson<{ data: any[] }>(`/workunits?${query}`);
  return body.data;
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

describe('#106 全链路 e2e：三工程 PMO → 开图 → 决策 → 成文 → 物化 → 依赖过滤 → 逐腿', () => {
  let channelId = '';
  let projectId = '';
  let pmoNumber = '';
  let analysisWuId = '';
  const decisionWuIds: string[] = [];
  let specWuId = '';
  let blockerWuId = '';
  let taskAWuId = ''; // 腿 1 任务单（无 blockedBy）
  let taskBWuId = ''; // 腿 2 任务单（blockedBy=blockerWuId）

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
    projectId = project.id;
    pmoNumber = project.pmoNumber;
    expect(projectId).toBeTruthy();
    expect(project.deliveries.length).toBe(3);
    expect(project.deliveries.map((l: any) => l.gitRepo)).toEqual(legRepos);
    expect(project.gitRepo).toBe(legRepos[0]); // 兼容字段取首工程
    expect(project.map ?? null).toBeNull(); // 未开图 = 非探路型
  });

  it('(1b) publish 发频道建分析单：多腿 scope 注入全部腿仓库（只读约束不变）', async () => {
    const result = await apiJson<any>(`/pmo/project/${projectId}/publish`, postJson({ channelId }));
    analysisWuId = result.workUnit.id;
    expect(analysisWuId).toBeTruthy();
    expect(result.workUnit.type).toBe('analysis');
    expect(result.project.status).toBe('active');

    const scope: string = result.workUnit.scope;
    expect(scope).toContain('多交付腿（只读范围）');
    for (const repo of legRepos) expect(scope).toContain(repo);
    const meta = wuMetadata(result.workUnit);
    expect(meta.pmoId).toBe(projectId);
    expect(meta.workspaceRoot).toBe(legRepos[0]);

    // 频道收到 PMO 发布帖
    const messages = await apiJson<{ data: any[] }>(`/channels/${channelId}/messages?limit=50`);
    expect(messages.data.some((m: any) => m.content.includes(pmoNumber))).toBe(true);
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

  it('(1d) 人工开图：分析确认（DESTINATION:/FOG:）→ 地图初始化 + 逐条建 decision 单', async () => {
    // 分析单走状态机到人工确认（agent 侧动作由 API 模拟）
    await transitionWu(analysisWuId, 'active');
    await transitionWu(analysisWuId, 'in_review');
    await reviewPass(analysisWuId, [
      '分析覆盖三仓，结论确认。待决问题如下：',
      'DESTINATION: 三仓特性联动上线',
      'FOG: 存储选型用哪个？',
      'FOG: 部署形态先单机还是分布式？',
    ].join('\n'));

    const project = await pollUntil('map opened', MECHANISM_TIMEOUT_MS, async () => {
      const p = await apiJson<any>(`/pmo/project/${projectId}`);
      return (p.map?.fog?.length === 2 && p.map.fog.every((f: any) => f.wuId)) ? p : null;
    });
    expect(project.map.destination).toBe('三仓特性联动上线');
    expect(project.map.decisions).toEqual([]);
    expect(project.map.fog.map((f: any) => f.status)).toEqual(['open', 'open']);
    expect(project.map.fog[0].question).toContain('存储选型');

    // 逐条建成的 decision 单：未指派、metadata 互挂 pmoId/fogId
    const decisions = await listWorkUnits(`type=decision&channelId=${channelId}&limit=50`);
    const ours = decisions.filter((w: any) => wuMetadata(w).pmoId === projectId);
    expect(ours.length).toBe(2);
    for (const w of ours) {
      expect(w.status).toBe('unassigned');
      const meta = wuMetadata(w);
      expect(meta.pmoNumber).toBe(pmoNumber);
      expect(project.map.fog.some((f: any) => f.id === meta.fogId && f.wuId === w.id)).toBe(true);
      decisionWuIds.push(w.id);
    }
    // 幂等哨兵落档
    expect(wuMetadata(await getWorkUnit(analysisWuId)).mapOpenedAt).toBeTruthy();
  });

  it('(2) 决策认领 → 线程讨论（NEED_INPUT 往返）→ 人工填结论通过 → decisions 追加 + fog resolved', async () => {
    const decisionId = decisionWuIds[0]!;
    // 认领（频道成员 loop 的认领动作用状态迁移模拟）
    await transitionWu(decisionId, 'active');

    // NEED_INPUT 往返：挂起提问 → 人类线程回复 → 恢复
    await transitionWu(decisionId, 'blocked');
    const question = await apiJson<any>(`/workunits/${decisionId}/messages`, postJson({
      content: '需要输入：存储选型倾向 PostgreSQL 还是 SQLite？',
      authorType: 'agent',
      agentName: 'kimi',
    }));
    expect(question.workUnitId ?? question.message?.workUnitId ?? question.data?.workUnitId).toBeTruthy();
    const reply = await apiJson<any>(`/workunits/${decisionId}/messages`, postJson({
      content: '用 PostgreSQL，理由：三仓都要关系型。',
    }));
    expect(reply).toBeTruthy();
    await transitionWu(decisionId, 'active');

    // 人工填写结论并点通过
    await transitionWu(decisionId, 'in_review');
    await reviewPass(decisionId, '存储用 PostgreSQL（三仓统一关系型）');

    const project = await pollUntil('decision landed', MECHANISM_TIMEOUT_MS, async () => {
      const p = await apiJson<any>(`/pmo/project/${projectId}`);
      return p.map?.decisions?.length === 1 ? p : null;
    });
    expect(project.map.decisions[0].wuId).toBe(decisionId);
    expect(project.map.decisions[0].summary).toBe('存储用 PostgreSQL（三仓统一关系型）');
    const fog0 = project.map.fog.find((f: any) => f.wuId === decisionId);
    expect(fog0.status).toBe('resolved');
    expect(project.map.fog.some((f: any) => f.status === 'open')).toBe(true); // 另一雾仍开
    expect(project.map.specSpawnedAt).toBeUndefined(); // 非全清不建成文单
  });

  it('(3) 最后一雾 resolved → 自动建成文单（specSpawnedAt 幂等 + specWuId 溯源）', async () => {
    const decisionId = decisionWuIds[1]!;
    await transitionWu(decisionId, 'active');
    await transitionWu(decisionId, 'in_review');
    await reviewPass(decisionId, '先单机部署，分布式后置');

    const project = await pollUntil('spec spawned', MECHANISM_TIMEOUT_MS, async () => {
      const p = await apiJson<any>(`/pmo/project/${projectId}`);
      return (p.map?.specSpawnedAt && p.map?.specWuId) ? p : null;
    });
    expect(project.map.fog.every((f: any) => f.status === 'resolved')).toBe(true);
    expect(project.map.decisions.length).toBe(2);

    specWuId = project.map.specWuId;
    const spec = await getWorkUnit(specWuId);
    expect(spec.type).toBe('spec');
    expect(spec.status).toBe('unassigned');
    expect(spec.scope).toContain(pmoNumber);
    expect(spec.scope).toContain('先单机部署');
    const meta = wuMetadata(spec);
    expect(meta.pmoId).toBe(projectId);
    expect(meta.pmoNumber).toBe(pmoNumber);
  });

  it('(4) 交稿通过 → 任务单批量物化：ac/blockedBy/腿归属齐全', async () => {
    // 预先存在的阻塞源任务单（物化清单的 BLOCKEDBY 引用它）
    const blocker = await apiJson<any>('/workunits', postJson({
      type: 'task',
      scope: '地基任务（物化任务的依赖源）',
      channelId,
      metadata: { pmoId: projectId, pmoNumber, workspaceRoot: legRepos[2] },
    }));
    blockerWuId = blocker.id;

    await transitionWu(specWuId, 'active');
    await transitionWu(specWuId, 'in_review');
    await reviewPass(specWuId, [
      '成文确认，物化如下：',
      `TASK: ${path.basename(legRepos[0]!)} 存储层实现 | AC: 单测全绿 | AC: 迁移回滚可用 | LEG: ${legRepos[0]}`,
      `TASK: ${path.basename(legRepos[1]!)} 接口层实现 | AC: 契约测试通过 | BLOCKEDBY: ${blockerWuId} | LEG: ${legRepos[1]}`,
    ].join('\n'));

    const tasks = await pollUntil('tasks materialized', MECHANISM_TIMEOUT_MS, async () => {
      const list = await listWorkUnits(`type=task&channelId=${channelId}&limit=50`);
      const ours = list.filter((w: any) => wuMetadata(w).creationMode === 'spec-materialization');
      return ours.length === 2 ? ours : null;
    });
    for (const w of tasks) {
      expect(w.status).toBe('unassigned');
      expect(w.parentId).toBe(specWuId);
    }
    // 按腿归属定名（列表序不保证，后续用例按语义引用）
    const taskA = tasks.find((w: any) => wuMetadata(w).workspaceRoot === legRepos[0]);
    const taskB = tasks.find((w: any) => wuMetadata(w).workspaceRoot === legRepos[1]);
    taskAWuId = taskA.id;
    taskBWuId = taskB.id;
    const metaA = wuMetadata(taskA);
    expect(metaA.pmoId).toBe(projectId);
    expect(metaA.ac).toEqual(['单测全绿', '迁移回滚可用']);
    const metaB = wuMetadata(taskB);
    expect(metaB.ac).toEqual(['契约测试通过']);
    expect(metaB.blockedBy).toEqual([blockerWuId]);

    // 幂等哨兵
    expect(wuMetadata(await getWorkUnit(specWuId)).specTasksSpawnedAt).toBeTruthy();
  });

  it('(5) 依赖过滤：blockedBy 未了结 claimable=false（对所有 loop 不可见），了结后 true', async () => {
    const claimableOf = async (id: string): Promise<boolean> => {
      const list = await listWorkUnits(`status=unassigned&limit=100`);
      const row = list.find((w: any) => w.id === id);
      return row?.claimable ?? false;
    };
    // 依赖未清：B 不可认领；A（无 blockedBy）与阻塞源可认领
    expect(await claimableOf(taskBWuId)).toBe(false);
    expect(await claimableOf(taskAWuId)).toBe(true);
    expect(await claimableOf(blockerWuId)).toBe(true);

    // 了结依赖源（走完整状态机：评审子单完结 + 人工确认）
    await completeCodeWu(blockerWuId);

    await pollUntil('taskB claimable after dep cleared', MECHANISM_TIMEOUT_MS, async () => {
      return (await claimableOf(taskBWuId)) ? true : null;
    });
  });

  it('(6+7) 逐腿台账独立演进 + 地图/台账 API 数据齐备（地图页渲染输入）', async () => {
    // 完成腿 1 的任务单（评审子单完结 + 人工通过）；腿 2 任务仍在途
    await completeCodeWu(taskAWuId);

    let lastDelivery: any = null;
    let delivery: any;
    try {
      delivery = await pollUntil('leg statuses diverge', MECHANISM_TIMEOUT_MS, async () => {
        const d = await apiJson<any>(`/pmo/project/${projectId}/delivery`);
        lastDelivery = d;
        const leg1 = d.legs?.find((l: any) => l.gitRepo === legRepos[0]);
        const leg2 = d.legs?.find((l: any) => l.gitRepo === legRepos[1]);
        // 腿 1：WU 全完结但缺 L1（代码类未验证）→ in_review；腿 2：仍有在途 → active
        return (leg1?.status === 'in_review' && leg2?.status === 'active') ? d : null;
      });
    } catch (err) {
      console.error('[e2e] last delivery legs:', JSON.stringify(lastDelivery?.legs?.map((l: any) => ({
        gitRepo: l.gitRepo, status: l.status, wu: l.wu, deliverable: l.deliverable, missing: l.missing,
      })), null, 2));
      throw err;
    }

    // 逐腿独立台账：三腿各自 gitRepo/状态/WU 计数
    expect(delivery.legs.length).toBe(3);
    const leg1 = delivery.legs.find((l: any) => l.gitRepo === legRepos[0]);
    const leg2 = delivery.legs.find((l: any) => l.gitRepo === legRepos[1]);
    const leg3 = delivery.legs.find((l: any) => l.gitRepo === legRepos[2]);
    expect(leg1.wu.total).toBeGreaterThan(0);
    expect(leg1.deliverable).toBe(false); // 缺 L1 证据
    expect(leg1.missing.some((m: string) => m.includes('L1'))).toBe(true);
    // 阻塞源归腿 3，已了结 → 腿 3 也只剩证据缺口（in_review 或 completed 视 L1 豁免口径）
    expect(['in_review', 'completed']).toContain(leg3.status);
    // 腿 2 在途分布可见
    expect(leg2.wu.byStatus.unassigned + leg2.wu.byStatus.active + leg2.wu.byStatus.inReview).toBeGreaterThan(0);

    // 标准 7 数据面：项目详情一次拿全地图 + 逐腿状态（地图页渲染输入）
    const project = await apiJson<any>(`/pmo/project/${projectId}`);
    expect(project.map.destination).toBe('三仓特性联动上线');
    expect(project.map.decisions.length).toBe(2);
    expect(project.map.fog.every((f: any) => f.status === 'resolved' && f.wuId)).toBe(true);
    expect(project.map.specWuId).toBe(specWuId);
    expect(project.deliveries.length).toBe(3);
    expect(project.deliveries.map((l: any) => l.status)).toEqual(delivery.legs.map((l: any) => l.status));
  });
});
