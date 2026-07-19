/**
 * MCP Tools — 经济系统
 *
 * T3 拆分：自 tools.ts 原样提取（getBalance）。
 */

import type { RegisteredTool } from './tool-registry.js';
import { getCompaniesDir, getEntity } from './tool-store.js';

// ─── 经济系统 ───

interface CompanyData {
  id: string;
  name: string;
}

const getBalance: RegisteredTool = {
  name: 'getBalance',
  description: '查询公司余额',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const company = await getEntity<CompanyData>(getCompaniesDir(), input.companyId);
    if (!company) throw new Error('Company not found');
    return { type: 'company', ...company };
  },
};

export const economyTools: RegisteredTool[] = [
  getBalance,
];
