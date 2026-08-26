/**
 * MCP Tools — 任务管理（FileStore）
 *
 * T3 拆分：自 tools.ts 原样提取
 * （getTaskBoard / createTask / assignTask / updateTaskStatus / getTaskStats）。
 */

import type { RegisteredTool } from './tool-registry.js';
import { generateId } from '@dommaker/studio-shared';
import {
  getTasksDir,
  getEntity,
  listJsonFiles,
  writeEntity,
} from './tool-store.js';

// ─── 任务管理（FileStore） ───

interface TaskData {
  id: string;
  projectId: string;
  name: string;
  assignee: string;
  description?: string;
  priority: string;
  status: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  estimatedHours?: number;
  claimedBy?: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  testEvidence?: string;
  createdAt: string;
  updatedAt: string;
}

const getTaskBoard: RegisteredTool = {
  name: 'getTaskBoard',
  description: '获取任务看板状态',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      status: { type: 'string', description: '状态过滤' },
    },
  },
  handler: async (input) => {
    let tasks = await listJsonFiles<TaskData>(getTasksDir());
    if (input.projectId) tasks = tasks.filter(t => t.projectId === input.projectId);
    if (input.status) tasks = tasks.filter(t => t.status === input.status);
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const subset = tasks.slice(0, 50).map(t => ({
      id: t.id, name: t.name, status: t.status, assignee: t.assignee, createdAt: t.createdAt,
    }));
    return { tasks: subset, total: subset.length };
  },
};

const createTask: RegisteredTool = {
  name: 'createTask',
  description: '创建新任务',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      name: { type: 'string', description: '任务名称' },
      assignee: { type: 'string', description: '指派角色类型 (developer/architect/qa/any)' },
      description: { type: 'string', description: '任务描述' },
      priority: { type: 'string', description: '优先级', enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
      meetingId: { type: 'string', description: '关联会议 ID' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 ID 列表' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '验收标准' },
      estimatedHours: { type: 'number', description: '预估工时' },
    },
    required: ['projectId', 'name', 'assignee'],
  },
  handler: async (input) => {
    const id = generateId('task');
    const now = new Date().toISOString();
    const task: TaskData = {
      id,
      projectId: input.projectId,
      name: input.name,
      assignee: input.assignee,
      description: input.description,
      priority: input.priority || 'P2',
      status: 'pending',
      dependsOn: input.dependsOn || [],
      acceptanceCriteria: input.acceptanceCriteria || [],
      estimatedHours: input.estimatedHours,
      createdAt: now,
      updatedAt: now,
    };
    await writeEntity(getTasksDir(), id, task);
    return { taskId: task.id, name: task.name, assignee: task.assignee, priority: task.priority };
  },
};

const assignTask: RegisteredTool = {
  name: 'assignTask',
  description: '认领任务（分配给指定角色）',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      roleId: { type: 'string', description: '认领角色 ID' },
    },
    required: ['taskId', 'roleId'],
  },
  handler: async (input) => {
    const task = await getEntity<TaskData>(getTasksDir(), input.taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'pending') throw new Error(`Task is not pending (current: ${task.status})`);

    const updated: TaskData = {
      ...task,
      claimedBy: input.roleId,
      claimedAt: new Date().toISOString(),
      status: 'claimed',
      updatedAt: new Date().toISOString(),
    };
    await writeEntity(getTasksDir(), input.taskId, updated);
    return { taskId: updated.id, status: updated.status, claimedBy: updated.claimedBy };
  },
};

const updateTaskStatus: RegisteredTool = {
  name: 'updateTaskStatus',
  description: '更新任务状态',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      status: { type: 'string', description: '新状态', enum: ['pending', 'blocked', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] },
      testEvidence: { type: 'string', description: '测试证据（完成时可选）' },
    },
    required: ['taskId', 'status'],
  },
  handler: async (input) => {
    const existing = await getEntity<TaskData>(getTasksDir(), input.taskId);
    if (!existing) throw new Error(`Task not found: ${input.taskId}`);

    const now = new Date().toISOString();
    const updated: TaskData = { ...existing, status: input.status, updatedAt: now };
    if (input.status === 'in_progress') updated.startedAt = now;
    if (input.status === 'completed') {
      updated.completedAt = now;
      if (input.testEvidence) updated.testEvidence = input.testEvidence;
    }
    await writeEntity(getTasksDir(), input.taskId, updated);
    return { taskId: updated.id, status: updated.status };
  },
};

const getTaskStats: RegisteredTool = {
  name: 'getTaskStats',
  description: '获取任务统计信息',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID（可选）' },
    },
  },
  handler: async (input) => {
    let tasks = await listJsonFiles<TaskData>(getTasksDir());
    if (input.projectId) tasks = tasks.filter(t => t.projectId === input.projectId);

    const statusMap: Record<string, number> = {};
    for (const t of tasks) {
      statusMap[t.status] = (statusMap[t.status] || 0) + 1;
    }

    return {
      total: tasks.length,
      pending: statusMap['pending'] || 0,
      claimed: statusMap['claimed'] || 0,
      in_progress: statusMap['in_progress'] || 0,
      completed: statusMap['completed'] || 0,
      failed: statusMap['failed'] || 0,
      blocked: statusMap['blocked'] || 0,
    };
  },
};

export const taskTools: RegisteredTool[] = [
  getTaskBoard,
  createTask,
  assignTask,
  updateTaskStatus,
  getTaskStats,
];
