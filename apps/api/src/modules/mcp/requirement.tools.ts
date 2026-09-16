/**
 * MCP Tools — Requirement 需求（P2，#566）
 *
 * 只读：getRequirement/listRequirements 包 RequirementService.get/list，
 * 均 exposure='external' 外放。写操作（create/update 等）维持 REST 面不进 MCP。
 */

import { RequirementService } from '../requirements/requirement.service.js';
import type { RegisteredTool } from './tool-registry.js';
import { fileStore } from './tool-store.js';

const getRequirement: RegisteredTool = {
  name: 'getRequirement',
  exposure: 'external',
  description: '按 ID 查询需求详情（REQ-<n> 统一编号或 legacy id）',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '需求 ID（REQ-<n> 或 legacy id）' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const requirement = await new RequirementService(fileStore).get(input.id);
    if (!requirement) throw new Error(`Requirement not found: ${input.id}`);
    return requirement;
  },
};

const listRequirements: RegisteredTool = {
  name: 'listRequirements',
  exposure: 'external',
  description: '列出需求（可按状态/频道过滤；legacy REQ 与统一编号 PMO 别名合并）',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '状态过滤' },
      channelId: { type: 'string', description: '频道过滤' },
    },
    required: [],
  },
  handler: async (input) => {
    const requirements = await new RequirementService(fileStore).list({
      status: input.status,
      channelId: input.channelId,
    });
    return { requirements, total: requirements.length };
  },
};

export const requirementTools: RegisteredTool[] = [
  getRequirement,
  listRequirements,
];
