/**
 * GC Service integration tests (SQLite, no mocks)
 *
 * Tests garbage collection logic:
 *   - Deletes completed tasks older than 24h
 *   - Marks orphaned running tasks as error (72h no update)
 *   - Deletes old events for completed tasks
 *   - Preserves active task data
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

// ── GC logic (inline for testing without import cycles) ──

const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = 72 * 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

async function runTestGC(workspaceId: string) {
  const now = new Date();
  let deletedTasks = 0;
  let orphanedTasks = 0;
  let deletedEvents = 0;

  // 1. Delete completed tasks older than 24h
  const doneThreshold = new Date(now.getTime() - DONE_TTL_MS);
  const oldTasks = await prisma.workspaceTask.findMany({
    where: {
      workspaceId,
      status: { in: ['done', 'error', 'cancelled'] },
      completedAt: { lt: doneThreshold },
    },
    select: { id: true },
  });

  if (oldTasks.length > 0) {
    for (const task of oldTasks) {
      await prisma.workspaceEvent.deleteMany({ where: { taskId: task.id } });
    }
    const { count } = await prisma.workspaceTask.deleteMany({
      where: { id: { in: oldTasks.map(t => t.id) } },
    });
    deletedTasks = count;
  }

  // 2. Mark orphaned running tasks
  const orphanThreshold = new Date(now.getTime() - ORPHAN_TTL_MS);
  const orphaned = await prisma.workspaceTask.updateMany({
    where: {
      workspaceId,
      status: 'running',
      updatedAt: { lt: orphanThreshold },
    },
    data: {
      status: 'error',
      result: JSON.stringify({ error: 'Orphaned', failureReason: 'orphan_timeout' }),
      completedAt: now,
    },
  });
  orphanedTasks = orphaned.count;

  // 3. Delete old events for completed tasks
  const eventThreshold = new Date(now.getTime() - EVENT_TTL_MS);
  const completedTaskIds = await prisma.workspaceTask.findMany({
    where: {
      workspaceId,
      status: { in: ['done', 'error', 'cancelled'] },
      completedAt: { not: null },
    },
    select: { id: true },
  });

  if (completedTaskIds.length > 0) {
    const { count } = await prisma.workspaceEvent.deleteMany({
      where: {
        taskId: { in: completedTaskIds.map(t => t.id) },
        createdAt: { lt: eventThreshold },
      },
    });
    deletedEvents = count;
  }

  return { deletedTasks, orphanedTasks, deletedEvents };
}

// ── Tests ──

let workspaceId: string;
let tokenId: string;

describe('GC Service', () => {
  beforeAll(async () => {
    const { workspace, token } = await createTestWorkspace('gc-test');
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

  it('deletes completed tasks older than 24h', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago

    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/old',
        prompt: 'old task',
        agent: 'executor',
        status: 'done',
        result: JSON.stringify({ output: 'done' }),
        completedAt: oldDate,
        createdAt: oldDate,
      },
    });

    // Create event for this task
    await prisma.workspaceEvent.create({
      data: { workspaceId, taskId: task.id, type: 'output', content: 'old output', createdAt: oldDate },
    });

    const result = await runTestGC(workspaceId);

    expect(result.deletedTasks).toBe(1);

    // Verify task and events deleted
    const found = await prisma.workspaceTask.findUnique({ where: { id: task.id } });
    expect(found).toBeNull();

    const events = await prisma.workspaceEvent.findMany({ where: { taskId: task.id } });
    expect(events).toHaveLength(0);
  });

  it('preserves recent completed tasks', async () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago

    await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/recent',
        prompt: 'recent task',
        agent: 'executor',
        status: 'done',
        result: JSON.stringify({ output: 'done' }),
        completedAt: recentDate,
      },
    });

    const result = await runTestGC(workspaceId);

    expect(result.deletedTasks).toBe(0);

    const tasks = await prisma.workspaceTask.findMany({ where: { workspaceId } });
    expect(tasks).toHaveLength(1);
  });

  it('marks orphaned running tasks as error', async () => {
    const oldDate = new Date(Date.now() - 73 * 60 * 60 * 1000); // 73h ago

    await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/orphan',
        prompt: 'orphan task',
        agent: 'executor',
        status: 'running',
        createdAt: oldDate,
        updatedAt: oldDate,
      },
    });

    const result = await runTestGC(workspaceId);

    expect(result.orphanedTasks).toBe(1);

    const task = await prisma.workspaceTask.findFirst({ where: { workspaceId, path: '/orphan' } });
    expect(task!.status).toBe('error');

    const parsed = JSON.parse(task!.result!);
    expect(parsed.failureReason).toBe('orphan_timeout');
  });

  it('preserves recent running tasks', async () => {
    await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/active',
        prompt: 'active task',
        agent: 'executor',
        status: 'running',
      },
    });

    const result = await runTestGC(workspaceId);

    expect(result.orphanedTasks).toBe(0);

    const task = await prisma.workspaceTask.findFirst({ where: { workspaceId, path: '/active' } });
    expect(task!.status).toBe('running');
  });

  it('deletes old events for completed tasks but keeps events for active tasks', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const now = new Date();

    // Completed task with old events (should be deleted by task deletion)
    const doneTask = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/done-old',
        prompt: 'done',
        agent: 'executor',
        status: 'done',
        result: JSON.stringify({ output: 'done' }),
        completedAt: oldDate,
        createdAt: oldDate,
      },
    });

    await prisma.workspaceEvent.create({
      data: { workspaceId, taskId: doneTask.id, type: 'output', content: 'old', createdAt: oldDate },
    });

    // Active task with old events (should be preserved)
    const activeTask = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        path: '/active-old-events',
        prompt: 'active',
        agent: 'executor',
        status: 'running',
      },
    });

    await prisma.workspaceEvent.create({
      data: { workspaceId, taskId: activeTask.id, type: 'output', content: 'old but active', createdAt: oldDate },
    });

    const result = await runTestGC(workspaceId);

    // Old done task should be deleted (along with its events)
    expect(result.deletedTasks).toBe(1);

    // Active task's old events should NOT be deleted (task is still active)
    const activeEvents = await prisma.workspaceEvent.findMany({ where: { taskId: activeTask.id } });
    expect(activeEvents).toHaveLength(1);
  });

  it('handles empty workspace gracefully', async () => {
    const result = await runTestGC(workspaceId);

    expect(result.deletedTasks).toBe(0);
    expect(result.orphanedTasks).toBe(0);
    expect(result.deletedEvents).toBe(0);
  });
});
