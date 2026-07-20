/**
 * MCP Tools — WorkUnit
 *
 * T3 拆分：自 tools.ts 原样提取（createWorkUnit）。
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
      type: { type: 'string', enum: ['task', 'analysis', 'monitor', 'discussion'], description: 'WorkUnit 类型' },
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

export const workunitTools: RegisteredTool[] = [
  createWorkUnit,
];
