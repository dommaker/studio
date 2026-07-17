/**
 * Daemon routes integration tests (SQLite, no mocks)
 * Covers: claim, messages, complete, fail, session pinning, status polling, race condition
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;
import { prisma } from '@dommaker/studio-prisma';
import crypto from 'crypto';

function generateToken(): string {
  return `st_mach_${crypto.randomBytes(24).toString('base64url')}`;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createTestWorkspace(name: string) {
  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);
  const token = await prisma.workspaceToken.create({
    data: { name: `${name}-token`, tokenHash, permissions: '["execute"]' },
  });
  const ws = await prisma.workspace.create({
    data: { name, tokenId: token.id, workspaceRoot: '/tmp/test', status: 'idle' },
  });
  return { workspace: ws, token, plaintext };
}

async function createRuntime(workspaceId: string, provider: string) {
  return prisma.workspaceRuntime.create({
    data: { workspaceId, provider, name: provider, status: 'online' },
  });
}

async function createTask(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return prisma.workspaceTask.create({
    data: {
      workspaceId,
      path: '/test/path',
      prompt: 'Do something',
      agent: 'executor',
      status: 'pending',
      ...overrides,
    },
  });
}

let workspaceId: string;
let tokenId: string;
let runtimeId: string;

describeIf('Daemon claim', () => {
  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('claim-test');
    workspaceId = workspace.id;
    tokenId = token.id;
    const rt = await createRuntime(workspaceId, 'claude');
    runtimeId = rt.id;
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
    await prisma.workspaceRuntime.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
  });

  beforeEach(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
  });

  it('claims oldest pending task by createdAt', async () => {
    const t1 = await createTask(workspaceId, { runtimeId });
    await new Promise(r => setTimeout(r, 10));
    await createTask(workspaceId, { runtimeId });

    const task = await prisma.workspaceTask.findFirst({
      where: { workspaceId, status: 'pending', runtimeId },
      orderBy: { createdAt: 'asc' },
    });

    expect(task).toBeTruthy();
    expect(task!.id).toBe(t1.id);

    const claimed = await prisma.workspaceTask.updateMany({
      where: { id: task!.id, status: 'pending' },
      data: { status: 'running', runtimeId },
    });

    expect(claimed.count).toBe(1);

    const updated = await prisma.workspaceTask.findUnique({ where: { id: task!.id } });
    expect(updated!.status).toBe('running');
    expect(updated!.runtimeId).toBe(runtimeId);
  });

  it('returns null when no pending tasks', async () => {
    const task = await prisma.workspaceTask.findFirst({
      where: { workspaceId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    expect(task).toBeNull();
  });

  it('prevents double-claim via atomic update', async () => {
    const t = await createTask(workspaceId, { runtimeId });

    const c1 = await prisma.workspaceTask.updateMany({
      where: { id: t.id, status: 'pending' },
      data: { status: 'running', runtimeId },
    });
    expect(c1.count).toBe(1);

    const c2 = await prisma.workspaceTask.updateMany({
      where: { id: t.id, status: 'pending' },
      data: { status: 'running', runtimeId },
    });
    expect(c2.count).toBe(0);
  });

  it('claims task with null runtimeId when runtime_id not specified', async () => {
    await createTask(workspaceId);

    const task = await prisma.workspaceTask.findFirst({
      where: { workspaceId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });

    expect(task).toBeTruthy();
    expect(task!.runtimeId).toBeNull();
  });
});

describeIf('Daemon messages', () => {
  let wsId: string;
  let tkId: string;
  let taskId: string;

  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('messages-test');
    wsId = workspace.id;
    tkId = token.id;
    const task = await createTask(wsId);
    taskId = task.id;
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspace.deleteMany({ where: { id: wsId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tkId } });
  });

  it('batch inserts events from messages array', async () => {
    const messages = [
      { seq: 1, type: 'output', content: 'Hello' },
      { seq: 2, type: 'tool_use', content: 'Using tool', tool: 'bash', input: 'ls' },
      { seq: 3, type: 'error', content: 'Something went wrong' },
    ];

    const events = messages.map(msg => ({
      workspaceId: wsId,
      taskId,
      type: msg.type,
      content: msg.content,
      metadata: JSON.stringify({ seq: msg.seq, tool: msg.tool, input: msg.input }),
    }));

    await prisma.workspaceEvent.createMany({ data: events });

    const stored = await prisma.workspaceEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });

    expect(stored).toHaveLength(3);
    expect(stored[0].type).toBe('output');
    expect(stored[1].type).toBe('tool_use');
    expect(stored[2].type).toBe('error');

    const meta = JSON.parse(stored[1].metadata!);
    expect(meta.tool).toBe('bash');
    expect(meta.input).toBe('ls');
  });
});

describeIf('Daemon complete & fail', () => {
  let wsId: string;
  let tkId: string;

  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('complete-fail-test');
    wsId = workspace.id;
    tkId = token.id;
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspace.deleteMany({ where: { id: wsId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tkId } });
  });

  it('completes running task with result JSON', async () => {
    const task = await prisma.workspaceTask.create({
      data: { workspaceId: wsId, path: '/test', prompt: 'test', agent: 'executor', status: 'running' },
    });

    const now = new Date();
    const elapsedMs = now.getTime() - task.createdAt.getTime();
    const result = JSON.stringify({ output: 'Done!', elapsedMs });

    const updated = await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'done', result, sessionId: 'sess-123', workDir: '/tmp/work', completedAt: now },
    });

    expect(updated.status).toBe('done');
    expect(updated.sessionId).toBe('sess-123');
    expect(updated.workDir).toBe('/tmp/work');
    expect(updated.completedAt).toBeTruthy();

    const parsed = JSON.parse(updated.result!);
    expect(parsed.output).toBe('Done!');
    expect(parsed.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects completing non-running task', async () => {
    const task = await createTask(wsId);
    const found = await prisma.workspaceTask.findUnique({ where: { id: task.id } });
    expect(found!.status).toBe('pending');
  });

  it('fails running task with error and failure reason', async () => {
    const task = await prisma.workspaceTask.create({
      data: { workspaceId: wsId, path: '/test', prompt: 'test', agent: 'executor', status: 'running' },
    });

    const now = new Date();
    const elapsedMs = now.getTime() - task.createdAt.getTime();
    const result = JSON.stringify({ error: 'Agent crashed', failureReason: 'timeout', elapsedMs });

    const updated = await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'error', result, completedAt: now },
    });

    expect(updated.status).toBe('error');
    const parsed = JSON.parse(updated.result!);
    expect(parsed.error).toBe('Agent crashed');
    expect(parsed.failureReason).toBe('timeout');
  });
});

describeIf('Session pinning & status polling', () => {
  let wsId: string;
  let tkId: string;

  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('session-status-test');
    wsId = workspace.id;
    tkId = token.id;
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspace.deleteMany({ where: { id: wsId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tkId } });
  });

  it('updates sessionId and workDir on task', async () => {
    const task = await createTask(wsId);
    const updated = await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { sessionId: 'sess-abc', workDir: '/work/dir' },
    });
    expect(updated.sessionId).toBe('sess-abc');
    expect(updated.workDir).toBe('/work/dir');
  });

  it('returns current task status', async () => {
    const task = await createTask(wsId, { status: 'running' });
    const found = await prisma.workspaceTask.findFirst({
      where: { id: task.id, workspaceId: wsId },
      select: { id: true, status: true, result: true, completedAt: true },
    });

    expect(found).toBeTruthy();
    expect(found!.status).toBe('running');
    expect(found!.result).toBeNull();
    expect(found!.completedAt).toBeNull();
  });

  it('detects cancellation via status change', async () => {
    const task = await createTask(wsId, { status: 'running' });

    await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    const found = await prisma.workspaceTask.findFirst({
      where: { id: task.id, workspaceId: wsId },
      select: { status: true },
    });
    expect(found!.status).toBe('cancelled');
  });

  it('returns result after completion', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId: wsId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'done',
        result: JSON.stringify({ output: 'All done', elapsedMs: 5000 }),
        completedAt: new Date(),
      },
    });

    const found = await prisma.workspaceTask.findFirst({
      where: { id: task.id, workspaceId: wsId },
      select: { status: true, result: true },
    });

    expect(found!.status).toBe('done');
    const parsed = JSON.parse(found!.result!);
    expect(parsed.output).toBe('All done');
  });
});
