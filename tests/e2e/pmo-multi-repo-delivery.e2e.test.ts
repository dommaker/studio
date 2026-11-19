/**
 * #723 多仓全链路验收：真实 API 子进程 + 两个真实 Git 仓库 + fake provider。
 * 只经公开 HTTP/Git/频道观察行为，不读取内部 Effect、Receipt 或 FileStore。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'fake-cli.mjs');
const BOOT_TIMEOUT_MS = 180_000;
const FLOW_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

let tmpRoot = '';
let homeDir = '';
let studioDir = '';
let repoA = '';
let repoB = '';
let port = 0;
let origin = '';
let apiBase = '';
let apiProc: ChildProcess | null = null;
let apiLogTail: string[] = [];
let apiLogPath = '';
let apiLogStream: ReturnType<typeof createWriteStream> | null = null;
let lastPollError: string | null = null;

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
      const value = addr.port;
      srv.close(() => resolve(value));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiJson<T = any>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${pathname}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function patchJson(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function putJson(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function pollUntil<T>(label: string, fn: () => Promise<T | null | false | undefined>, timeoutMs = FLOW_TIMEOUT_MS): Promise<T> {
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
  const tail = apiLogTail.slice(-40).join('');
  lastPollError = `pollUntil("${label}") timed out after ${timeoutMs}ms.${lastErr ? ` last error: ${lastErr}` : ''}\n(full api log: ${apiLogPath})\n--- api log tail ---\n${tail}`;
  throw new Error(lastPollError);
}

async function getWorkUnit(id: string): Promise<any> {
  return (await apiJson<{ data: any }>(`/workunits/${id}`)).data;
}

async function listWorkUnits(query: string): Promise<any[]> {
  return (await apiJson<{ data: any[] }>(`/workunits?${query}`)).data;
}

async function getChannelMessages(channelId: string): Promise<any[]> {
  return (await apiJson<{ data: { messages: any[] } }>(`/channels/${channelId}/messages?limit=100`)).data.messages;
}

function metadata(wu: any): Record<string, any> {
  if (!wu?.metadata) return {};
  return typeof wu.metadata === 'string' ? JSON.parse(wu.metadata) : wu.metadata;
}

async function listKnowledgeProposals(workUnitId: string): Promise<any[]> {
  const channels = (await apiJson<{ data: any[] }>('/channels?limit=100')).data;
  const proposals: any[] = [];
  for (const channel of channels) {
    const messages = await getChannelMessages(channel.id);
    for (const message of messages) {
      const meta = typeof message.meta === 'string' ? JSON.parse(message.meta || '{}') : (message.meta ?? {});
      if (meta.cardType === 'knowledge_proposal' && meta.cardData?.workUnitId === workUnitId) {
        proposals.push(meta.cardData);
      }
    }
  }
  return proposals;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function initGitRepo(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@studio.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, '.gitignore'), [
    'node_modules/', '.agent.log', '.claude/', '.codex/', '.daemon/', '.harness/', '.kimi-code/', 'CLAUDE.md', '',
  ].join('\n'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name, private: true, type: 'module', scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

async function bootApi(): Promise<void> {
  port = await findFreePort();
  origin = `http://127.0.0.1:${port}`;
  apiBase = `${origin}/api/v1`;
  apiProc = spawn(TSX_BIN, ['apps/api/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      STUDIO_HOME: studioDir,
      STUDIO_CONFIG_DIR: studioDir,
      STUDIO_DATA_DIR: path.join(studioDir, 'data'),
      STUDIO_EVENTS_FILE: path.join(tmpRoot, 'events', 'studio-events.jsonl'),
      PORT: String(port),
      NODE_ENV: 'test',
      STUDIO_AUTH: 'none',
      STUDIO_AGENT_LOOP_ENABLED: 'true',
      STUDIO_AUTO_REVIEW: 'true',
      STUDIO_KNOWLEDGE_EXTRACTION: 'true',
      STUDIO_INCREMENTAL_CONTEXT: 'true',
      STUDIO_CLAIM_FITNESS: 'false',
      WORKTREES_DIR: path.join(tmpRoot, 'worktrees'),
      EVENTS_DIR: path.join(tmpRoot, 'events'),
      KNOWLEDGE_DIR: path.join(tmpRoot, 'harness-knowledge'),
      REPO_DIR: repoA,
      VPS_WORKSPACE_ROOT: repoA,
      PMO_GIT_REPO_ROOTS: tmpRoot,
      CLOUDFLARED_ENABLED: 'false',
      PATH: `${path.join(tmpRoot, 'bin')}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.stdout?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.stderr?.on('data', (d: Buffer) => logApi(d.toString()));
  apiProc.on('exit', (code, sig) => logApi(`[e2e] api exited code=${code} sig=${sig}\n`));
  await pollUntil('api ready', async () => {
    try {
      const res = await fetch(`${origin}/readyz`);
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }, BOOT_TIMEOUT_MS);
}

async function stopApi(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!apiProc) return;
  const proc = apiProc;
  apiProc = null;
  const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
  proc.kill(signal);
  await Promise.race([exited, sleep(10_000)]);
  if (proc.exitCode === null && !proc.signalCode) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    await Promise.race([exited, sleep(1_000)]);
  }
}

describe('#723 多仓全链路验收', () => {
  let channelId = '';
  let executorId = '';
  let reviewerId = '';
  let project: any = null;
  let planId = '';
  let taskAId = '';
  let taskBId = '';

  beforeAll(async () => {
    if (!existsSync(TSX_BIN)) throw new Error(`tsx not found at ${TSX_BIN}`);
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'pmo-multi-repo-e2e-'));
    homeDir = path.join(tmpRoot, 'home');
    studioDir = path.join(homeDir, '.studio');
    repoA = path.join(tmpRoot, 'repo-a');
    repoB = path.join(tmpRoot, 'repo-b');
    mkdirSync(studioDir, { recursive: true });
    mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
    initGitRepo(repoA, 'e2e-repo-a');
    initGitRepo(repoB, 'e2e-repo-b');
    writeExecutable(path.join(tmpRoot, 'bin', 'systemd-run'), '#!/bin/sh\nexit 0\n');
    writeExecutable(path.join(tmpRoot, 'bin', 'vitest'), '#!/bin/sh\nmkdir -p node_modules\ntouch node_modules/.e2e-verify-started\nsleep 8\nexec node --test\n');
    writeExecutable(path.join(tmpRoot, 'bin', 'pnpm'), '#!/bin/sh\nif [ "$1" != exec ] || [ "$2" != vitest ]; then exit 64; fi\nshift 2\nexec vitest "$@"\n');
    const fakeBin = path.join(tmpRoot, 'bin', 'e2e-fake');
    copyFileSync(FAKE_CLI, fakeBin);
    chmodSync(fakeBin, 0o755);
    writeFileSync(path.join(studioDir, 'providers.json'), JSON.stringify({
      providers: {
        'e2e-fake': {
          displayName: 'E2E Fake CLI',
          binaries: ['e2e-fake'],
          versionArgs: ['--version'],
          healthProbeArgs: ['--version'],
          scanDefault: false,
          spawn: {
            baseArgs: [],
            defaultOutputFormat: 'stream-json',
            sessionIdFlag: '--session',
            promptViaStdin: true,
          },
        },
      },
    }, null, 2));
    port = await findFreePort();
    origin = `http://127.0.0.1:${port}`;
    apiBase = `${origin}/api/v1`;
    apiLogPath = path.join(tmpRoot, 'api.log');
    apiLogStream = createWriteStream(apiLogPath);
    await bootApi();
  }, BOOT_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await stopApi();
    if (apiLogStream) await new Promise(resolve => apiLogStream!.end(resolve));
    apiLogStream = null;
    if (tmpRoot && !process.env.E2E_KEEP_TMP && !lastPollError) {
      await sleep(500);
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } else if (tmpRoot) {
      console.error(`[e2e] temporary root kept at ${tmpRoot}`);
    }
  }, 30_000);

  it('从 PMO 发布经 NEED_INPUT 回复拆出两个隔离交付腿', async () => {
    channelId = (await apiJson<{ data: any }>('/channels', postJson({ name: 'e2e-multi-repo', type: 'rnd' }))).data.id;
    for (const name of ['executor', 'reviewer']) {
      const profile = (await apiJson<{ data: any }>('/agent-profiles', postJson({
        name, description: `#723 ${name}`, provider: 'e2e-fake', status: 'active', channels: [channelId],
      }))).data;
      if (name === 'executor') executorId = profile.id;
      else reviewerId = profile.id;
    }
    await apiJson(`/channels/${channelId}/members`, patchJson({ add: [executorId, reviewerId] }));
    const profiles = (await apiJson<{ data: any[] }>('/agent-profiles?includeSystem=true&status=active&limit=100')).data;
    const studio = profiles.find(profile => profile.name === 'studio');
    expect(studio).toBeTruthy();
    await apiJson(`/agent-profiles/${studio.id}`, patchJson({ provider: 'e2e-fake' }));

    project = (await apiJson<{ data: any }>('/pmo/project', postJson({
      title: 'E2E 多仓交付',
      requirement: 'E2E_MULTI_REPO',
      gitRepos: [repoA, repoB],
      deliveryPolicy: 'branch-only',
      overallReviewRequired: true,
    }))).data;
    const branches = [`${project.pmoNumber}-a`, `${project.pmoNumber}-b`];
    project = (await apiJson<{ data: any }>(`/pmo/project/${project.id}`, putJson({
      deliveries: [
        { gitRepo: repoA, branch: branches[0], status: 'pending' },
        { gitRepo: repoB, branch: branches[1], status: 'pending' },
      ],
    }))).data;

    const published = (await apiJson<{ data: any }>(`/pmo/project/${project.id}/publish`, postJson({
      channelId, assigneeId: executorId,
    }))).data;
    planId = published.workUnit.id;
    expect(published.workUnit.scope).toContain(repoA);
    expect(published.workUnit.scope).toContain(repoB);
    expect(published.workUnit.scope).toContain(branches[0]);
    expect(published.workUnit.scope).toContain(branches[1]);

    await pollUntil('plan NEED_INPUT', async () => {
      const wu = await getWorkUnit(planId);
      return wu.status === 'blocked' && metadata(wu).waitingForInput ? wu : null;
    });
    const question = await pollUntil('plan question message', async () => {
      const messages = await getChannelMessages(channelId);
      return messages.find(message => message.workUnitId === planId && message.content.includes('请确认按两个指定仓库')) ?? null;
    });
    await apiJson(`/channels/${channelId}/messages`, postJson({
      content: '按两个指定仓库分别实现，继续。', replyToId: question.id,
    }));
    await pollUntil('plan complete', async () => {
      const wu = await getWorkUnit(planId);
      return wu.status === 'in_review' ? wu : null;
    });
    expect(metadata(await getWorkUnit(planId)).analysisTaskDetails).toEqual([
      { title: 'E2E_TASK_A 实现 A', leg: repoA, ac: ['A 实现及测试通过'], blockedBy: [] },
      { title: 'E2E_TASK_B 实现 B', leg: repoB, ac: ['B 实现及测试通过'], blockedBy: [] },
    ]);

    await apiJson(`/workunits/${planId}/review-passed`, postJson({
      defaultAssigneeId: executorId,
      confirm: {
        kind: 'plan',
        tasks: [
          { title: 'E2E_TASK_A 实现 A', leg: repoA, ac: ['A 实现及测试通过'], blockedBy: [] },
          { title: 'E2E_TASK_B 实现 B', leg: repoB, ac: ['B 实现及测试通过'], blockedBy: [] },
        ],
      },
    }));
    const tasks = await pollUntil('two materialized tasks', async () => {
      const list = await listWorkUnits(`parentId=${planId}&limit=100`);
      return list.length === 2 ? list : null;
    });
    const taskA = tasks.find(task => task.scope.includes('E2E_TASK_A'));
    const taskB = tasks.find(task => task.scope.includes('E2E_TASK_B'));
    taskAId = taskA.id;
    taskBId = taskB.id;
    expect(metadata(taskA).workspaceRoot).toBe(repoA);
    expect(metadata(taskA).pmoBranch).toBe(branches[0]);
    expect(metadata(taskB).workspaceRoot).toBe(repoB);
    expect(metadata(taskB).pmoBranch).toBe(branches[1]);
    expect(metadata(taskA).ac).toEqual(['A 实现及测试通过']);
    expect(metadata(taskB).ac).toEqual(['B 实现及测试通过']);
  });

  it('知识回流后替换丢失会话，并从外部副作用与合并中恢复', async () => {
    const planProposal = await pollUntil('plan knowledge proposal', async () => {
      const proposals = await listKnowledgeProposals(planId);
      return proposals.length === 1 ? proposals[0] : null;
    });
    expect(planProposal.entries.map((entry: any) => entry.title)).toEqual(['E2E_PLAN_KNOWLEDGE']);
    await apiJson(`/review-proposals/knowledge/${planProposal.proposalId}/approve`, postJson({}));
    const planEntry = await pollUntil('plan knowledge verified', async () => {
      const body = await apiJson<{ data: { entries: any[] } }>('/knowledge/unified?limit=100&sortBy=createdAt');
      return body.data.entries.find(entry => entry.title === 'E2E_PLAN_KNOWLEDGE' && entry.maturity === 'verified') ?? null;
    });
    expect(JSON.stringify(planEntry.sourceReferences)).toContain(repoA);

    const question = await pollUntil('task A NEED_INPUT', async () => {
      const messages = await getChannelMessages(channelId);
      return messages.find(message => message.workUnitId === taskAId && message.content.includes('请确认继续实现 A')) ?? null;
    });
    await apiJson(`/channels/${channelId}/messages`, postJson({ content: '继续实现 A。', replyToId: question.id }));
    await pollUntil('task A waiting review', async () => {
      const wu = await getWorkUnit(taskAId);
      return wu.status === 'in_review' ? wu : null;
    });

    // 知识提取被人为延迟；此时杀掉进程，review-dispatch / external-reply /
    // knowledge-extraction 可能已执行也可能未执行，重启后都必须收敛且不重复。
    await stopApi('SIGKILL');
    await bootApi();
    const reviews = await pollUntil('exactly one review after restart', async () => {
      const list = await listWorkUnits(`parentId=${taskAId}&type=review&limit=100`);
      return list.length === 1 ? list : null;
    });
    expect(reviews[0].id).toBeTruthy();

    await pollUntil('merge verification started', async () => {
      const root = path.join(tmpRoot, 'worktrees');
      if (!existsSync(root)) return null;
      return readdirSync(root, { recursive: true }).some(entry =>
        String(entry).replaceAll('\\', '/').endsWith('node_modules/.e2e-verify-started')) ? true : null;
    });
    await stopApi('SIGKILL');
    await bootApi();

    const done = await pollUntil('task A merged and done', async () => {
      const wu = await getWorkUnit(taskAId);
      return wu.status === 'done' ? wu : null;
    });
    expect(done.completedAt).toBeTruthy();
    expect(metadata(done).mergeReceipt).toMatchObject({ merged: true, verification: { status: 'passed' } });
    expect(await listWorkUnits(`parentId=${taskAId}&type=review&limit=100`)).toHaveLength(1);
    const assignments = done.execution?.assignments ?? [];
    const replyAssignment = assignments.find((assignment: any) => assignment.reason === 'need-input-reply');
    const replacement = assignments.find((assignment: any) => assignment.reason === 'session-replacement');
    expect(replyAssignment, JSON.stringify(assignments)).toBeTruthy();
    expect(replacement, JSON.stringify(assignments)).toBeTruthy();
    expect(replacement.previousAssignmentId).toBe(replyAssignment.id);

    const branch = project.deliveries[0].branch;
    const taskBranch = metadata(done).worktreeBranch;
    expect(taskBranch).toBeTruthy();
    expect(() => git(repoA, ['merge-base', '--is-ancestor', taskBranch, branch])).not.toThrow();
    const mergeSubjects = git(repoA, ['log', branch, '--format=%s']).split('\n');
    expect(mergeSubjects.filter(subject => subject.startsWith(`merge: ${taskAId}`))).toHaveLength(1);

    const messages = await getChannelMessages(channelId);
    const results = messages.filter(message => message.workUnitId === taskAId && message.content.includes('E2E_IMPL_A'));
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain(`commonDir=${path.join(repoA, '.git')}`);
    expect(results[0].content).toContain('RECOVERY_SEEN=true');

    const recalled = await pollUntil('plan knowledge consumed by task A', async () => {
      const body = await apiJson<{ data: { entries: any[] } }>('/knowledge/unified?limit=100&sortBy=createdAt');
      const entry = body.data.entries.find(item => item.id === planEntry.id);
      return entry?.lastReferenced > planEntry.lastReferenced ? entry : null;
    });
    expect(recalled.referencedBy).toEqual(expect.arrayContaining([expect.stringMatching(/^prompt-inject:/)]));

    const proposalA = await pollUntil('task A knowledge recovered', async () => {
      const proposals = await listKnowledgeProposals(taskAId);
      return proposals.length === 1 ? proposals[0] : null;
    });
    expect(proposalA.entries.map((entry: any) => entry.title)).toEqual(['E2E_IMPL_A_KNOWLEDGE']);
    await apiJson(`/review-proposals/knowledge/${proposalA.proposalId}/approve`, postJson({}));

    await apiJson(`/workunits/${taskAId}/review-passed`, postJson({}));
    await apiJson(`/workunits/${reviews[0].id}/review-passed`, postJson({}));
  });

  it('隔离完成 B 仓，经整体评审逐腿交付且不改 main', async () => {
    const mainA = git(repoA, ['rev-parse', 'main']);
    const mainB = git(repoB, ['rev-parse', 'main']);
    if ((await getWorkUnit(taskBId)).status === 'blocked') {
      const question = await pollUntil('task B NEED_INPUT', async () => {
        const messages = await getChannelMessages(channelId);
        return messages.find(message => message.workUnitId === taskBId && message.content.includes('请确认继续实现 B')) ?? null;
      });
      await apiJson(`/channels/${channelId}/messages`, postJson({ content: '继续实现 B。', replyToId: question.id }));
    }
    const done = await pollUntil('task B merged and done', async () => {
      const wu = await getWorkUnit(taskBId);
      return wu.status === 'done' ? wu : null;
    });
    expect(metadata(done).workspaceRoot).toBe(repoB);
    expect(metadata(done).mergeReceipt).toMatchObject({ merged: true, verification: { status: 'passed' } });
    const branchB = project.deliveries[1].branch;
    expect(() => git(repoB, ['merge-base', '--is-ancestor', metadata(done).worktreeBranch, branchB])).not.toThrow();
    const reviews = await listWorkUnits(`parentId=${taskBId}&type=review&limit=100`);
    expect(reviews).toHaveLength(1);
    await apiJson(`/workunits/${taskBId}/review-passed`, postJson({}));
    await apiJson(`/workunits/${reviews[0].id}/review-passed`, postJson({}));

    const messages = await getChannelMessages(channelId);
    const resultA = messages.find(message => message.workUnitId === taskAId && message.content.includes('E2E_IMPL_A'));
    const resultB = messages.find(message => message.workUnitId === taskBId && message.content.includes('E2E_IMPL_B'));
    expect(resultB.content).toContain(`commonDir=${path.join(repoB, '.git')}`);
    expect(resultB.content).toContain('PLAN_KB_SEEN=false');
    const sessionA = resultA.content.match(/cli=([^ ]+)/)?.[1];
    const sessionB = resultB.content.match(/cli=([^ ]+)/)?.[1];
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);

    const commitA = git(repoA, ['rev-parse', project.deliveries[0].branch]);
    const gated = await fetch(`${apiBase}/pmo/project/${project.id}/mark-delivered`, postJson({
      commit: commitA, leg: project.deliveries[0].branch,
    }));
    expect(gated.status).toBe(409);
    await pollUntil('overall candidate review approved', async () => {
      const body = await apiJson<{ data: any }>(`/pmo/project/${project.id}/delivery`);
      return body.data.overallReview?.status === 'approved' && body.data.deliverable ? body.data : null;
    });

    await apiJson(`/pmo/project/${project.id}/mark-delivered`, postJson({
      commit: commitA, leg: project.deliveries[0].branch,
    }));
    const partial = (await apiJson<{ data: any }>(`/pmo/project/${project.id}`)).data;
    expect(partial.deliveredAt ?? null).toBeNull();
    expect(partial.deliveries[0].deliveredAt).toBeTruthy();
    expect(partial.deliveries[1].deliveredAt ?? null).toBeNull();

    const commitB = git(repoB, ['rev-parse', branchB]);
    await apiJson(`/pmo/project/${project.id}/mark-delivered`, postJson({ commit: commitB, leg: branchB }));
    const delivered = (await apiJson<{ data: any }>(`/pmo/project/${project.id}`)).data;
    expect(delivered.deliveredAt).toBeTruthy();
    expect(delivered.deliveries.every((leg: any) => leg.deliveredAt && leg.deliverCommit && leg.deliveredBy)).toBe(true);
    expect(git(repoA, ['rev-parse', 'main'])).toBe(mainA);
    expect(git(repoB, ['rev-parse', 'main'])).toBe(mainB);
  });
});
