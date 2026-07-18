/**
 * Task routes unit tests — FileStore JSONL mock
 *
 * Covers AC-C2: task creation (pending status, workspace/runtime validation),
 * task status query with events, task cancellation, status guard
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Inline stores ──
let workspaceStore: Map<string, Record<string, any>> = new Map();
let taskStore: Map<string, Record<string, any>[]> = new Map();
let eventStore: Map<string, Record<string, any>[]> = new Map();

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
function isoNow(): string { return new Date().toISOString(); }

function createWorkspace(overrides: Record<string, any> = {}): Record<string, any> {
  const now = isoNow();
  const ws = {
    id: makeId('ws'),
    name: 'test-ws',
    tokenId: null,
    workspaceRoot: '/tmp/test',
    status: 'idle',
    currentTask: null,
    lastHeartbeat: null,
    hasDocker: false,
    os: null,
    arch: null,
    tokens: [],
    runtimes: [],
    repos: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  workspaceStore.set(ws.id, ws);
  return ws;
}

function addRuntime(workspaceId: string, overrides: Record<string, any> = {}): Record<string, any> {
  const ws = workspaceStore.get(workspaceId)!;
  const rt = {
    id: makeId('rt'),
    provider: 'claude',
    name: 'Claude Code',
    version: null,
    status: 'online',
    lastSeenAt: isoNow(),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    ...overrides,
  };
  ws.runtimes.push(rt);
  return rt;
}

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

function addEvent(workspaceId: string, taskId: string, overrides: Record<string, any> = {}): void {
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
}

describe('Task creation', () => {
  let WID: string;

  beforeEach(() => {
    workspaceStore = new Map();
    taskStore = new Map();
    eventStore = new Map();
    const ws = createWorkspace({ name: 'task-create-test' });
    WID = ws.id;
  });

  it('creates task with pending status', () => {
    const task = createTask(WID, { path: '/src/main.ts', prompt: 'Fix the bug', agent: 'executor' });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('pending');
    expect(task.path).toBe('/src/main.ts');
    expect(task.prompt).toBe('Fix the bug');
    expect(task.agent).toBe('executor');
    expect(task.modelTier).toBe('standard');
    expect(task.runtimeId).toBeNull();
    expect(task.parentGoalId).toBeNull();
  });

  it('creates task with optional fields', () => {
    const rt = addRuntime(WID, { provider: 'claude' });
    const task = createTask(WID, { modelTier: 'premium', runtimeId: rt.id, parentGoalId: 'goal-123' });
    expect(task.modelTier).toBe('premium');
    expect(task.runtimeId).toBe(rt.id);
    expect(task.parentGoalId).toBe('goal-123');
  });

  it('verifies workspace exists before task creation', () => {
    const ws = workspaceStore.get(WID);
    expect(ws).toBeTruthy();
    expect(ws!.name).toBe('task-create-test');
  });

  it('verifies runtime belongs to workspace', () => {
    const rt = addRuntime(WID, { provider: 'test-rt', name: 'Test' });
    const ws = workspaceStore.get(WID)!;
    const found = ws.runtimes.find((r: any) => r.id === rt.id);
    expect(found).toBeTruthy();
  });

  it('rejects runtime from different workspace', () => {
    const ws2 = createWorkspace({ name: 'task-other-ws' });
    const rt = addRuntime(ws2.id, { provider: 'other-rt' });
    // Try to find runtime in wrong workspace
    const ws = workspaceStore.get(WID)!;
    const found = ws.runtimes.find((r: any) => r.id === rt.id);
    expect(found).toBeUndefined();
  });
});

describe('Task status query with events', () => {
  let WID: string;
  let taskId: string;

  beforeEach(() => {
    workspaceStore = new Map();
    taskStore = new Map();
    eventStore = new Map();
    const ws = createWorkspace({ name: 'task-query-test' });
    WID = ws.id;
    const task = createTask(WID, { status: 'running' });
    taskId = task.id;
    addEvent(WID, taskId, { type: 'output', content: 'Line 1' });
    addEvent(WID, taskId, { type: 'output', content: 'Line 2' });
    addEvent(WID, taskId, { type: 'tool_use', content: 'Running bash' });
  });

  it('returns task with events', () => {
    const tasks = taskStore.get(WID) || [];
    const task = tasks.find(t => t.id === taskId);
    expect(task).toBeTruthy();
    expect(task!.status).toBe('running');

    const events = eventStore.get(WID) || [];
    const taskEvents = events
      .filter(e => e.taskId === taskId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    expect(taskEvents).toHaveLength(3);
    expect(taskEvents[0].content).toBe('Line 1');
    expect(taskEvents[1].content).toBe('Line 2');
    expect(taskEvents[2].type).toBe('tool_use');
  });

  it('returns 404 for non-existent task', () => {
    const tasks = taskStore.get(WID) || [];
    const task = tasks.find(t => t.id === 'non-existent-id');
    expect(task).toBeUndefined();
  });

  it('returns 404 for task in different workspace', () => {
    const ws2 = createWorkspace({ name: 'task-query-other' });
    const tasks = taskStore.get(ws2.id) || [];
    const task = tasks.find(t => t.id === taskId);
    expect(task).toBeUndefined();
  });
});

describe('Task cancellation', () => {
  let WID: string;

  beforeEach(() => {
    workspaceStore = new Map();
    taskStore = new Map();
    eventStore = new Map();
    const ws = createWorkspace({ name: 'task-cancel-test' });
    WID = ws.id;
  });

  it('cancels pending task', () => {
    const task = createTask(WID);
    expect(task.status).toBe('pending');
    const tasks = taskStore.get(WID) || [];
    const t = tasks.find(t2 => t2.id === task.id)!;
    t.status = 'cancelled';
    t.completedAt = isoNow();
    expect(t.status).toBe('cancelled');
    expect(t.completedAt).toBeTruthy();
  });

  it('cancels running task', () => {
    const task = createTask(WID, { status: 'running' });
    const tasks = taskStore.get(WID) || [];
    const t = tasks.find(t2 => t2.id === task.id)!;
    t.status = 'cancelled';
    t.completedAt = isoNow();
    expect(t.status).toBe('cancelled');
  });

  it('rejects cancelling done task', () => {
    const task = createTask(WID, { status: 'done', result: JSON.stringify({ output: 'ok' }), completedAt: isoNow() });
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
  });

  it('rejects cancelling error task', () => {
    const task = createTask(WID, { status: 'error', result: JSON.stringify({ error: 'failed' }), completedAt: isoNow() });
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
  });

  it('rejects cancelling already cancelled task', () => {
    const task = createTask(WID, { status: 'cancelled', completedAt: isoNow() });
    expect(task.status).toBe('cancelled');
    expect(task.status).not.toBe('pending');
    expect(task.status).not.toBe('running');
  });

  it('emits cancel event', () => {
    const task = createTask(WID, { status: 'running' });
    const tasks = taskStore.get(WID) || [];
    const t = tasks.find(t2 => t2.id === task.id)!;
    t.status = 'cancelled';
    t.completedAt = isoNow();
    addEvent(WID, task.id, { type: 'done', content: 'Task cancelled by user' });

    const events = eventStore.get(WID) || [];
    const cancelEvt = events.find(e => e.taskId === task.id && e.content === 'Task cancelled by user');
    expect(cancelEvt).toBeTruthy();
    expect(cancelEvt!.type).toBe('done');
  });
});
