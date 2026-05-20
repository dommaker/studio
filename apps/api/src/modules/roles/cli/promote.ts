import type { PromoteOptions } from '../types';

// Mock 数据
const mockRoles = {
  '1': { id: '1', name: 'Alice', level: 2 },
  '2': { id: '2', name: 'Bob', level: 3 },
  'max-level': { id: 'max-level', name: 'Max', level: 4 },
};

const LEVEL_INFO = {
  2: { salary: 10000, capabilityLimit: 20 },
  3: { salary: 20000, capabilityLimit: 30 },
  4: { salary: 40000, capabilityLimit: 50 },
};

export async function runPromote(options: PromoteOptions): Promise<{ output: string; error?: string }> {
  const role = mockRoles[options.role as keyof typeof mockRoles];
  
  if (!role) {
    return { output: '', error: `角色 ${options.role} 不存在` };
  }
  
  if (!options.confirm) {
    return { output: '请使用 --confirm 确认晋升操作' };
  }
  
  if (role.level >= 4) {
    return { output: '', error: '已达最高级 L4，无法晋升' };
  }
  
  const newLevel = role.level + 1;
  const info = LEVEL_INFO[newLevel as keyof typeof LEVEL_INFO];
  
  return {
    output: `Role ${role.name} promoted from L${role.level} to L${newLevel}\nNew salary: ${info.salary}\nNew capability limit: ${info.capabilityLimit}`
  };
}