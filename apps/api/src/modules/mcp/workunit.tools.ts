/**
 * MCP Tools — WorkUnit
 *
 * T3 拆分：自 tools.ts 原样提取（createWorkUnit）。
 * P2（#566）：补只读查询 getWorkUnit/listWorkUnits，均 exposure='external' 外放。
 */

import { WorkUnitService } from '../workunit/workunit.service.js';
import type { RegisteredTool } from './tool-registry.js';
import { fileStore } from './tool-store.js';

// ─── WorkUnit ───

const createWorkUnit: RegisteredTool = {
  name: 'createWorkUnit',
  description: '创建 WorkUnit（工作单元）。Agent 用于拆分下游任务。',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['task', 'plan', 'analysis', 'monitor', 'discussion'], description: 'WorkUnit 类型' },
      scope: { type: 'string', description: '工作范围描述' },
      channelId: { type: 'string', description: 'Channel ID（可选）' },
      parentId: { type: 'string', description: '父 WorkUnit ID（可选）' },
      metadata: { type: 'object', description: '附加元数据（可选）' },
    },
    required: ['type', 'scope'],
  },
  handler: async (input) => {
    const workUnitService = new WorkUnitService(fileStore);
    const workunit = await workUnitService.create({
      type: input.type,
      scope: input.scope,
      channelId: input.channelId,
      parentId: input.parentId,
      metadata: input.metadata,
      status: 'unassigned',
    });
    return {
      workUnitId: workunit.id,
      type: workunit.type,
      scope: workunit.scope,
      status: workunit.status,
    };
  },
};

const getWorkUnit: RegisteredTool = {
  name: 'getWorkUnit',
  exposure: 'external',
  description: '按 ID 查询单个 WorkUnit 详情（状态、认领人、类型、scope 等）',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'WorkUnit ID' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const workUnitService = new WorkUnitService(fileStore);
    const workunit = await workUnitService.getById(input.id);
    if (!workunit) throw new Error(`WorkUnit not found: ${input.id}`);
    return workunit;
  },
};

const listWorkUnits: RegisteredTool = {
  name: 'listWorkUnits',
  exposure: 'external',
  description: '列出 WorkUnit（可按类型/状态/频道/归属项目过滤，按创建时间倒序分页）',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: '类型过滤（task/plan/analysis/monitor/discussion）' },
      status: { type: 'string', description: '状态过滤' },
      assigneeId: { type: 'string', description: '认领人过滤' },
      channelId: { type: 'string', description: '频道过滤' },
      parentId: { type: 'string', description: '父 WorkUnit 过滤' },
      projectId: { type: 'string', description: 'PMO 项目归属过滤' },
      q: { type: 'string', description: 'scope 子串过滤（大小写不敏感）' },
      page: { type: 'number', description: '页码（默认 1）' },
      limit: { type: 'number', description: '每页数量（默认 20）' },
    },
    required: [],
  },
  handler: async (input) => {
    const workUnitService = new WorkUnitService(fileStore);
    return workUnitService.list({
      type: input.type,
      status: input.status,
      assigneeId: input.assigneeId,
      channelId: input.channelId,
      parentId: input.parentId,
      projectId: input.projectId,
      q: input.q,
      page: input.page,
      limit: input.limit,
    });
  },
};

export const workunitTools: RegisteredTool[] = [
  createWorkUnit,
  getWorkUnit,
  listWorkUnits,
];
