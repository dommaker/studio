import type { DemoteOptions } from '../types';

// Mock 数据
const mockRoles = {
  '1': { id: '1', name: 'Alice', level: 2 },
  '3': { id: '3', name: 'Charlie', level: 3 },
  'min-level': { id: 'min-level', name: 'Min', level: 1 },
};

const LEVEL_INFO = {
  1: { salary: 5000, capabilityLimit: 10 },
  2: { salary: 10000, capabilityLimit: 20 },
};

export async function runDemote(options: DemoteOptions): Promise<{ output: string; error?: string }> {
  const role = mockRoles[options.role as keyof typeof mockRoles];
  
  if (!role) {
    return { output: '', error: `角色 ${options.role} 不存在` };
  }
  
  if (!options.reason) {
    return { output: '', error: '请提供降级原因 --reason=<text>' };
  }
  
  if (role.level <= 1) {
    return { output: '', error: '已是最低级 L1，无法降级' };
  }
  
  const newLevel = role.level - 1;
  const info = LEVEL_INFO[newLevel as keyof typeof LEVEL_INFO];
  
  return {
    output: `Role ${role.name} demoted from L${role.level} to L${newLevel}\nReason: ${options.reason}\nNew salary: ${info.salary}`
  };
}