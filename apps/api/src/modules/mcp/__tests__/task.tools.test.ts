/**
 * task.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 getTaskBoard / createTask / assignTask / updateTaskStatus / getTaskStats。
 * HOME 指向临时目录以隔离真实任务数据（模块在设置 HOME 之后动态导入）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let taskTools: import('../tool-registry.js').RegisteredTool[];
let TASKS_DIR: string;

function tool(name: string) {
  const t = taskTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

function writeTask(id: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({
    id, projectId: 'p1', name: id, assignee: 'developer', priority: 'P2',
    status: 'pending', dependsOn: [], acceptanceCriteria: [],
    createdAt: now, updatedAt: now, ...patch,
  }));
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-tools-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const mod = await import('../task.tools.js');
  taskTools = mod.taskTools;
  TASKS_DIR = (await import('../tool-store.js')).getTasksDir();
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('task.tools', () => {
  it('导出 5 个 tool，注册顺序不变', () => {
    expect(taskTools.map(t => t.name)).toEqual([
      'getTaskBoard', 'createTask', 'assignTask', 'updateTaskStatus', 'getTaskStats',
    ]);
  });

  it('createTask 写入默认值并返回摘要', async () => {
    const result = await tool('createTask').handler({ projectId: 'p1', name: 'T1', assignee: 'qa' });
    expect(result).toMatchObject({ name: 'T1', assignee: 'qa', priority: 'P2' });
    const saved = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${result.taskId}.json`), 'utf-8'));
    expect(saved).toMatchObject({
      projectId: 'p1', name: 'T1', assignee: 'qa', priority: 'P2',
      status: 'pending', dependsOn: [], acceptanceCriteria: [],
    });
    expect(result.taskId).toMatch(/^task_/);
  });

  it('getTaskBoard 按 projectId/status 过滤并裁减字段', async () => {
    writeTask('tb_a', { projectId: 'pb', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' });
    writeTask('tb_b', { projectId: 'pb', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z' });
    writeTask('tb_c', { projectId: 'pc', status: 'pending', createdAt: '2026-01-03T00:00:00.000Z' });

    const byProject = await tool('getTaskBoard').handler({ projectId: 'pb' });
    expect(byProject.total).toBe(2);
    expect(byProject.tasks.map((t: any) => t.id)).toEqual(['tb_b', 'tb_a']);
    expect(byProject.tasks[0]).toEqual({
      id: 'tb_b', name: 'tb_b', status: 'pending', assignee: 'developer',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const byStatus = await tool('getTaskBoard').handler({ projectId: 'pb', status: 'completed' });
    expect(byStatus.tasks.map((t: any) => t.id)).toEqual(['tb_a']);
  });

  it('assignTask 认领 pending 任务；非 pending 或不存在时抛错', async () => {
    writeTask('as_a');
    const result = await tool('assignTask').handler({ taskId: 'as_a', roleId: 'role-1' });
    expect(result).toMatchObject({ taskId: 'as_a', status: 'claimed', claimedBy: 'role-1' });
    const saved = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, 'as_a.json'), 'utf-8'));
    expect(saved.status).toBe('claimed');
    expect(saved.claimedAt).toBeTruthy();

    await expect(tool('assignTask').handler({ taskId: 'as_a', roleId: 'r' }))
      .rejects.toThrow('Task is not pending (current: claimed)');
    await expect(tool('assignTask').handler({ taskId: 'nope', roleId: 'r' }))
      .rejects.toThrow('Task not found');
  });

  it('updateTaskStatus 记录 startedAt/completedAt/testEvidence', async () => {
    writeTask('up_a');
    const r1 = await tool('updateTaskStatus').handler({ taskId: 'up_a', status: 'in_progress' });
    expect(r1).toEqual({ taskId: 'up_a', status: 'in_progress' });
    let saved = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, 'up_a.json'), 'utf-8'));
    expect(saved.startedAt).toBeTruthy();

    await tool('updateTaskStatus').handler({ taskId: 'up_a', status: 'completed', testEvidence: 'evidence-url' });
    saved = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, 'up_a.json'), 'utf-8'));
    expect(saved.completedAt).toBeTruthy();
    expect(saved.testEvidence).toBe('evidence-url');

    await expect(tool('updateTaskStatus').handler({ taskId: 'nope', status: 'completed' }))
      .rejects.toThrow('Task not found: nope');
  });

  it('getTaskStats 按状态计数并支持 projectId 过滤', async () => {
    writeTask('st_a', { projectId: 'ps', status: 'pending' });
    writeTask('st_b', { projectId: 'ps', status: 'completed' });
    writeTask('st_c', { projectId: 'ps', status: 'completed' });

    const stats = await tool('getTaskStats').handler({ projectId: 'ps' });
    expect(stats).toEqual({
      total: 3, pending: 1, claimed: 0, in_progress: 0, completed: 2, failed: 0, blocked: 0,
    });
  });
});
