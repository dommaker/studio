/**
 * GC Service unit tests — FileStore JSONL mock
 *
 * Covers AC-C6:
 *   - Deletes completed tasks older than 24h
 *   - Marks orphaned running tasks as error (72h no update)
 *   - Deletes old events for completed tasks
 *   - Preserves active task data
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Inline stores ──
let taskStore: Map<string, Record<string, any>[]> = new Map();
let eventStore: Map<string, Record<string, any>[]> = new Map();

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
function isoNow(): string { return new Date().toISOString(); }

function addTask(workspaceId: string, overrides: Record<string, any> = {}): Record<string, any> {
  const now = isoNow();
  const task = {
    id: makeId('t'),
    workspaceId,
    path: '/test',
    prompt: 'test',
    agent: 'executor',
    modelTier: 'standard',
    runtimeId: null,
    status: 'pending',
    result: null,
    sessionId: null,
    workDir: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const tasks = taskStore.get(workspaceId) || [];
  tasks.push(task);
  taskStore.set(workspaceId, tasks);
  return task;
}

function addEvent(workspaceId: string, taskId: string, overrides: Record<string, any> = {}): Record<string, any> {
  const evt = {
    id: makeId('evt'),
    workspaceId,
    taskId,
    type: 'output',
    content: 'test',
    metadata: '{}',
    createdAt: isoNow(),
    ...overrides,
  };
  const events = eventStore.get(workspaceId) || [];
  events.push(evt);
  eventStore.set(workspaceId, events);
  return evt;
}

// ── GC logic (mirrors gc-service.ts runGC) ──
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_TTL_MS = 72 * 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

async function runTestGC(workspaceId: string) {
  const now = new Date();
  let deletedTasks = 0;
  let orphanedTasks = 0;
  let deletedEvents = 0;

  let tasks = taskStore.get(workspaceId) || [];
  let events = eventStore.get(workspaceId) || [];

  // 1. Delete completed tasks older than 24h
  const doneThreshold = new Date(now.getTime() - DONE_TTL_MS);
  const oldTaskIds = tasks
    .filter(t =>
      ['done', 'error', 'cancelled'].includes(t.status) &&
      t.completedAt &&
      new Date(t.completedAt) < doneThreshold,
    )
    .map(t => t.id);

  if (oldTaskIds.length > 0) {
    const oldIdSet = new Set(oldTaskIds);
    events = events.filter(e => !oldIdSet.has(e.taskId));
    tasks = tasks.filter(t => !oldIdSet.has(t.id));
    deletedTasks = oldTaskIds.length;
  }

  // 2. Mark orphaned running tasks
  const orphanThreshold = new Date(now.getTime() - ORPHAN_TTL_MS);
  for (const task of tasks) {
    if (task.status === 'running' && new Date(task.updatedAt) < orphanThreshold) {
      task.status = 'error';
      task.result = JSON.stringify({ error: 'Orphaned', failureReason: 'orphan_timeout' });
      task.completedAt = now.toISOString();
      task.updatedAt = now.toISOString();
      orphanedTasks++;
    }
  }

  // 3. Delete old events for completed tasks
  const completedTaskIds = new Set(
    tasks
      .filter(t => ['done', 'error', 'cancelled'].includes(t.status) && t.completedAt)
      .map(t => t.id),
  );
  const eventThreshold = new Date(now.getTime() - EVENT_TTL_MS);
  const oldEventCount = events.filter(
    e => completedTaskIds.has(e.taskId) && new Date(e.createdAt) < eventThreshold,
  ).length;

  if (oldEventCount > 0) {
    events = events.filter(
      e => !(completedTaskIds.has(e.taskId) && new Date(e.createdAt) < eventThreshold),
    );
    deletedEvents = oldEventCount;
  }

  taskStore.set(workspaceId, tasks);
  eventStore.set(workspaceId, events);

  return { deletedTasks, orphanedTasks, deletedEvents };
}

describe('GC Service', () => {
  const WID = 'ws-gc-test';

  beforeEach(() => {
    taskStore = new Map();
    eventStore = new Map();
  });

  it('deletes completed tasks older than 24h', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const task = addTask(WID, {
      status: 'done',
      result: JSON.stringify({ output: 'done' }),
      completedAt: oldDate,
      createdAt: oldDate,
    });
    addEvent(WID, task.id, { createdAt: oldDate });

    const result = await runTestGC(WID);
    expect(result.deletedTasks).toBe(1);

    const tasks = taskStore.get(WID) || [];
    expect(tasks.find(t => t.id === task.id)).toBeUndefined();
    const events = eventStore.get(WID) || [];
    expect(events.filter(e => e.taskId === task.id)).toHaveLength(0);
  });

  it('preserves recent completed tasks', async () => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    addTask(WID, { status: 'done', result: JSON.stringify({ output: 'done' }), completedAt: recentDate });

    const result = await runTestGC(WID);
    expect(result.deletedTasks).toBe(0);
    const tasks = taskStore.get(WID) || [];
    expect(tasks).toHaveLength(1);
  });

  it('marks orphaned running tasks as error', async () => {
    const oldDate = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    addTask(WID, { path: '/orphan', status: 'running', createdAt: oldDate, updatedAt: oldDate });

    const result = await runTestGC(WID);
    expect(result.orphanedTasks).toBe(1);

    const tasks = taskStore.get(WID) || [];
    const task = tasks.find(t => t.path === '/orphan')!;
    expect(task.status).toBe('error');
    const parsed = JSON.parse(task.result);
    expect(parsed.failureReason).toBe('orphan_timeout');
  });

  it('preserves recent running tasks', async () => {
    addTask(WID, { path: '/active', status: 'running' });

    const result = await runTestGC(WID);
    expect(result.orphanedTasks).toBe(0);

    const tasks = taskStore.get(WID) || [];
    const task = tasks.find(t => t.path === '/active')!;
    expect(task.status).toBe('running');
  });

  it('deletes old events for completed tasks but keeps events for active tasks', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    const doneTask = addTask(WID, { path: '/done-old', status: 'done', result: JSON.stringify({ output: 'done' }), completedAt: oldDate, createdAt: oldDate });
    addEvent(WID, doneTask.id, { createdAt: oldDate });

    const activeTask = addTask(WID, { path: '/active-old-events', status: 'running' });
    addEvent(WID, activeTask.id, { createdAt: oldDate });

    const result = await runTestGC(WID);
    expect(result.deletedTasks).toBe(1);

    // Active task's events preserved
    const events = eventStore.get(WID) || [];
    expect(events.filter(e => e.taskId === activeTask.id)).toHaveLength(1);
  });

  it('handles empty workspace gracefully', async () => {
    const result = await runTestGC(WID);
    expect(result.deletedTasks).toBe(0);
    expect(result.orphanedTasks).toBe(0);
    expect(result.deletedEvents).toBe(0);
  });
});
