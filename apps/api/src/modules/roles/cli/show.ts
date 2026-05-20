import type { ShowOptions, RoleDetail } from '../types';

// Mock 数据
const mockRoles: Record<string, RoleDetail> = {
  '1': {
    id: '1', name: 'Alice', type: 'Developer', level: 2,
    workflows: [],
    status: 'Active', companyId: '1',
    performance: { totalTasks: 150, avgQuality: 4.5, lastActive: '2026-04-18' }
  },
  '2': {
    id: '2', name: 'Bob', type: 'Developer', level: 3,
    workflows: [],
    status: 'Active', companyId: '1',
    performance: { totalTasks: 200, avgQuality: 4.8, lastActive: '2026-04-18' }
  },
};

export async function runShow(options: ShowOptions): Promise<{ output: string; error?: string }> {
  const role = mockRoles[options.role];
  
  if (!role) {
    return { output: '', error: `角色 ${options.role} 不存在` };
  }

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify(role, null, 2) };
  }
  
  // table 格式
  const lines = [
    `Role: ${role.name} (L${role.level} ${role.type})`,
    `Status: ${role.status}`,
    `Performance: ${role.performance.totalTasks} tasks, ${role.performance.avgQuality} avg quality`,
    `Last Active: ${role.performance.lastActive}`
  ];
  return { output: lines.join('\n') };
}