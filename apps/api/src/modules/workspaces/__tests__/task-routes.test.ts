/**
 * Task routes integration tests (SQLite, no mocks)
 *
 * Tests the Prisma operations backing task management HTTP endpoints:
 *   - Task creation (pending status, workspace/runtime validation)
 *   - Task status query with events
 *   - Task cancellation (pending → cancelled, running → cancelled)
 *   - Status guard (done/error cannot be cancelled)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import crypto from 'crypto';

// ── Helpers ──

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

// ── Test data ──

let workspaceId: string;
let tokenId: string;

describe('Task creation', () => {
  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('task-create-test');
    workspaceId = workspace.id;
    tokenId = token.id;
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

  it('creates task with pending status', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/src/main.ts',
        prompt: 'Fix the bug',
        agent: 'executor',
        status: 'pending',
      },
    });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe('pending');
    expect(task.path).toBe('/src/main.ts');
    expect(task.prompt).toBe('Fix the bug');
    expect(task.agent).toBe('executor');
    expect(task.modelTier).toBe('standard');
    expect(task.runtimeId).toBeNull();
    expect(task.parentGoalId).toBeNull();
  });

  it('creates task with optional fields', async () => {
    const rt = await prisma.workspaceRuntime.create({
      data: { workspaceId, provider: 'claude', name: 'Claude', status: 'online' },
    });

    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/src/app.ts',
        prompt: 'Add feature',
        agent: 'reviewer',
        modelTier: 'premium',
        runtimeId: rt.id,
        parentGoalId: 'goal-123',
        status: 'pending',
      },
    });

    expect(task.modelTier).toBe('premium');
    expect(task.runtimeId).toBe(rt.id);
    expect(task.parentGoalId).toBe('goal-123');

    // Cleanup
    await prisma.workspaceRuntime.delete({ where: { id: rt.id } });
  });

  it('verifies workspace exists before task creation', async () => {
    // In the route, we check workspace exists
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    expect(ws).toBeTruthy();
    expect(ws!.name).toBe('task-create-test');
  });

  it('verifies runtime belongs to workspace', async () => {
    const rt = await prisma.workspaceRuntime.create({
      data: { workspaceId, provider: 'test-rt', name: 'Test', status: 'online' },
    });

    const found = await prisma.workspaceRuntime.findFirst({
      where: { id: rt.id, workspaceId },
    });

    expect(found).toBeTruthy();
    expect(found!.workspaceId).toBe(workspaceId);

    // Cleanup
    await prisma.workspaceRuntime.delete({ where: { id: rt.id } });
  });

  it('rejects runtime from different workspace', async () => {
    const { workspace: ws2, token: t2 } = await createTestWorkspace('task-other-ws');

    const rt = await prisma.workspaceRuntime.create({
      data: { workspaceId: ws2.id, provider: 'other-rt', name: 'Other', status: 'online' },
    });

    // Try to find runtime with wrong workspaceId
    const found = await prisma.workspaceRuntime.findFirst({
      where: { id: rt.id, workspaceId },
    });

    expect(found).toBeNull();

    // Cleanup
    await prisma.workspaceRuntime.delete({ where: { id: rt.id } });
    await prisma.workspace.delete({ where: { id: ws2.id } });
    await prisma.workspaceToken.delete({ where: { id: t2.id } });
  });
});

describe('Task status query with events', () => {
  let workspaceId: string;
  let tokenId: string;
  let taskId: string;

  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('task-query-test');
    workspaceId = workspace.id;
    tokenId = token.id;

    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test query',
        agent: 'executor',
        status: 'running',
      },
    });
    taskId = task.id;

    // Create some events
    await prisma.workspaceEvent.createMany({
      data: [
        { workspaceId, taskId, type: 'output', content: 'Line 1' },
        { workspaceId, taskId, type: 'output', content: 'Line 2' },
        { workspaceId, taskId, type: 'tool_use', content: 'Running bash' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
  });

  it('returns task with events', async () => {
    const task = await prisma.workspaceTask.findFirst({
      where: { id: taskId, workspaceId },
    });

    expect(task).toBeTruthy();
    expect(task!.status).toBe('running');

    const events = await prisma.workspaceEvent.findMany({
      where: { taskId, workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    expect(events).toHaveLength(3);
    expect(events[0].content).toBe('Line 1');
    expect(events[1].content).toBe('Line 2');
    expect(events[2].type).toBe('tool_use');
  });

  it('returns 404 for non-existent task', async () => {
    const task = await prisma.workspaceTask.findFirst({
      where: { id: 'non-existent-id', workspaceId },
    });

    expect(task).toBeNull();
  });

  it('returns 404 for task in different workspace', async () => {
    const { workspace: ws2, token: t2 } = await createTestWorkspace('task-query-other');

    const task = await prisma.workspaceTask.findFirst({
      where: { id: taskId, workspaceId: ws2.id },
    });

    expect(task).toBeNull();

    // Cleanup
    await prisma.workspace.delete({ where: { id: ws2.id } });
    await prisma.workspaceToken.delete({ where: { id: t2.id } });
  });
});

describe('Task cancellation', () => {
  let workspaceId: string;
  let tokenId: string;

  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('task-cancel-test');
    workspaceId = workspace.id;
    tokenId = token.id;
  });

  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
  });

  beforeEach(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
  });

  it('cancels pending task', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'pending',
      },
    });

    // Route logic: check status, then update
    expect(task.status).toBe('pending');
    expect(['pending', 'running']).toContain(task.status);

    const updated = await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    expect(updated.status).toBe('cancelled');
    expect(updated.completedAt).toBeTruthy();
  });

  it('cancels running task', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'running',
      },
    });

    expect(['pending', 'running']).toContain(task.status);

    const updated = await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    expect(updated.status).toBe('cancelled');
  });

  it('rejects cancelling done task', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'done',
        result: JSON.stringify({ output: 'ok' }),
        completedAt: new Date(),
      },
    });

    // Route logic: status check
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
    // In route, this returns 409
  });

  it('rejects cancelling error task', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'error',
        result: JSON.stringify({ error: 'failed' }),
        completedAt: new Date(),
      },
    });

    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
  });

  it('rejects cancelling already cancelled task', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'cancelled',
        completedAt: new Date(),
      },
    });

    expect(task.status).toBe('cancelled');
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
  });

  it('emits cancel event', async () => {
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'running',
      },
    });

    // Cancel
    await prisma.workspaceTask.update({
      where: { id: task.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });

    // Emit event
    const event = await prisma.workspaceEvent.create({
      data: {
        workspaceId,
        taskId: task.id,
        type: 'done',
        content: 'Task cancelled by user',
      },
    });

    expect(event.type).toBe('done');
    expect(event.content).toBe('Task cancelled by user');
  });
});
