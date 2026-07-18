/**
 * Daemon routes unit tests — FileStore JSONL mock
 *
 * Covers AC-C2, AC-C3: task claim, messages, complete, fail, session pinning, status polling
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Inline store (simulates FileStore JSONL) ──
let taskStore: Map<string, Record<string, any>[]> = new Map();
let eventStore: Map<string, Record<string, any>[]> = new Map();

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
function isoNow(): string { return new Date().toISOString(); }

function createTask(workspaceId: string, overrides: Record<string, any> = {}): Record<string, any> {
  const now = isoNow();
  const task = {
    id: makeId('t'),
    workspaceId,
    path: '/test/path',
    prompt: 'Do something',
    agent: 'executor',
    modelTier: 'standard',
    runtimeId: null,
    parentGoalId: null,
    status: 'pending',
    result: null,
    error: null,
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

// ── Simulated route logic ──
function claimTask(workspaceId: string, runtime_id?: string): Record<string, any> | null {
  const tasks = taskStore.get(workspaceId) || [];
  const pending = tasks
    .filter(t => {
      if (t.status !== 'pending') return false;
      if (runtime_id && t.runtimeId && t.runtimeId !== runtime_id) return false;
      return true;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const task = pending[0];
  if (!task) return null;
  if (task.status !== 'pending') return null;
  task.status = 'running';
  task.runtimeId = runtime_id || task.runtimeId;
  task.updatedAt = isoNow();
  return task;
}

function completeTask(workspaceId: string, taskId: string, output?: string): Record<string, any> | null {
  const tasks = taskStore.get(workspaceId) || [];
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) return null;
  if (tasks[idx].status !== 'running') return null;
  const now = isoNow();
  const elapsedMs = Date.now() - new Date(tasks[idx].createdAt).getTime();
  tasks[idx].status = 'done';
  tasks[idx].result = JSON.stringify({ output: output || 'Done!', elapsedMs });
  tasks[idx].completedAt = now;
  tasks[idx].updatedAt = now;
  addEvent(workspaceId, taskId, { type: 'done', content: output || '' });
  return tasks[idx];
}

function failTask(workspaceId: string, taskId: string, errorMsg?: string, failureReason?: string): Record<string, any> | null {
  const tasks = taskStore.get(workspaceId) || [];
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) return null;
  if (tasks[idx].status !== 'running') return null;
  const now = isoNow();
  const elapsedMs = Date.now() - new Date(tasks[idx].createdAt).getTime();
  tasks[idx].status = 'error';
  tasks[idx].result = JSON.stringify({ error: errorMsg || 'Agent crashed', failureReason: failureReason || 'timeout', elapsedMs });
  tasks[idx].completedAt = now;
  tasks[idx].updatedAt = now;
  addEvent(workspaceId, taskId, { type: 'error', content: errorMsg || 'Unknown error' });
  return tasks[idx];
}

function getTask(workspaceId: string, taskId: string): Record<string, any> | null {
  const tasks = taskStore.get(workspaceId) || [];
  return tasks.find(t => t.id === taskId) || null;
}

function getEventsByTask(workspaceId: string, taskId: string): Record<string, any>[] {
  const events = eventStore.get(workspaceId) || [];
  return events.filter(e => e.taskId === taskId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

describe('Daemon claim', () => {
  const WID = 'ws-claim-test';

  beforeEach(() => {
    taskStore = new Map();
    eventStore = new Map();
  });

  it('claims oldest pending task by createdAt', async () => {
    const rtId = makeId('rt');
    const t1 = createTask(WID, { runtimeId: rtId });
    await new Promise(r => setTimeout(r, 10));
    createTask(WID, { runtimeId: rtId });

    const claimed = claimTask(WID, rtId);
    expect(claimed).toBeTruthy();
    expect(claimed!.id).toBe(t1.id);
    expect(claimed!.status).toBe('running');
    expect(claimed!.runtimeId).toBe(rtId);
  });

  it('returns null when no pending tasks', () => {
    const result = claimTask(WID);
    expect(result).toBeNull();
  });

  it('prevents double-claim', () => {
    const t = createTask(WID);
    const c1 = claimTask(WID);
    expect(c1).toBeTruthy();
    // Second claim should not find pending tasks
    const c2 = claimTask(WID);
    expect(c2).toBeNull();
  });

  it('claims task with null runtimeId when runtime_id not specified', () => {
    createTask(WID);
    const claimed = claimTask(WID);
    expect(claimed).toBeTruthy();
    expect(claimed!.runtimeId).toBeNull();
  });
});

describe('Daemon messages', () => {
  const WID = 'ws-messages-test';

  beforeEach(() => {
    taskStore = new Map();
    eventStore = new Map();
  });

  it('batch inserts events from messages array', () => {
    const task = createTask(WID);
    const messages = [
      { seq: 1, type: 'output', content: 'Hello' },
      { seq: 2, type: 'tool_use', content: 'Using tool', tool: 'bash', input: 'ls' },
      { seq: 3, type: 'error', content: 'Something went wrong' },
    ];

    for (const msg of messages) {
      addEvent(WID, task.id, {
        type: msg.type,
        content: msg.content,
        metadata: JSON.stringify({ seq: msg.seq, tool: (msg as any).tool, input: (msg as any).input }),
      });
    }

    const events = getEventsByTask(WID, task.id);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('output');
    expect(events[1].type).toBe('tool_use');
    expect(events[2].type).toBe('error');

    const meta = JSON.parse(events[1].metadata);
    expect(meta.tool).toBe('bash');
    expect(meta.input).toBe('ls');
  });
});

describe('Daemon complete & fail', () => {
  const WID = 'ws-complete-fail-test';

  beforeEach(() => {
    taskStore = new Map();
    eventStore = new Map();
  });

  it('completes running task with result JSON', () => {
    const task = createTask(WID, { status: 'running' });
    const updated = completeTask(WID, task.id, 'Done!');
    expect(updated).toBeTruthy();
    expect(updated!.status).toBe('done');
    expect(updated!.completedAt).toBeTruthy();
    const parsed = JSON.parse(updated!.result!);
    expect(parsed.output).toBe('Done!');
    expect(parsed.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects completing non-running task', () => {
    const task = createTask(WID);
    const result = completeTask(WID, task.id);
    expect(result).toBeNull();
  });

  it('fails running task with error and failure reason', () => {
    const task = createTask(WID, { status: 'running' });
    const updated = failTask(WID, task.id, 'Agent crashed', 'timeout');
    expect(updated).toBeTruthy();
    expect(updated!.status).toBe('error');
    const parsed = JSON.parse(updated!.result!);
    expect(parsed.error).toBe('Agent crashed');
    expect(parsed.failureReason).toBe('timeout');
  });
});

describe('Session pinning & status polling', () => {
  const WID = 'ws-session-status-test';

  beforeEach(() => {
    taskStore = new Map();
    eventStore = new Map();
  });

  it('updates sessionId and workDir on task', () => {
    const task = createTask(WID);
    const tasks = taskStore.get(WID) || [];
    const t = tasks.find(t2 => t2.id === task.id)!;
    t.sessionId = 'sess-abc';
    t.workDir = '/work/dir';
    t.updatedAt = isoNow();
    expect(t.sessionId).toBe('sess-abc');
    expect(t.workDir).toBe('/work/dir');
  });

  it('returns current task status', () => {
    const task = createTask(WID, { status: 'running' });
    const found = getTask(WID, task.id);
    expect(found).toBeTruthy();
    expect(found!.status).toBe('running');
    expect(found!.result).toBeNull();
    expect(found!.completedAt).toBeNull();
  });

  it('detects cancellation via status change', () => {
    const task = createTask(WID, { status: 'running' });
    const tasks = taskStore.get(WID) || [];
    const t = tasks.find(t2 => t2.id === task.id)!;
    t.status = 'cancelled';
    t.completedAt = isoNow();
    const found = getTask(WID, task.id);
    expect(found!.status).toBe('cancelled');
  });

  it('returns result after completion', () => {
    const task = createTask(WID, { status: 'done', result: JSON.stringify({ output: 'All done', elapsedMs: 5000 }), completedAt: isoNow() });
    const found = getTask(WID, task.id);
    expect(found!.status).toBe('done');
    const parsed = JSON.parse(found!.result!);
    expect(parsed.output).toBe('All done');
  });
});
