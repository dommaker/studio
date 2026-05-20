import type { ListOptions, RoleInfo } from '../types';

// Mock 数据
const mockRoles: RoleInfo[] = [
  { id: '1', name: 'Alice', type: 'Developer', level: 2, workflows: ['feature-dev'], status: 'Active', companyId: '1' },
  { id: '2', name: 'Bob', type: 'Developer', level: 3, workflows: ['feature-dev', 'review'], status: 'Active', companyId: '1' },
  { id: '3', name: 'Charlie', type: 'Manager', level: 4, workflows: ['project-plan'], status: 'Active', companyId: '1' },
];

export async function runList(options: ListOptions): Promise<{ output: string; error?: string }> {
  // 验证公司
  if (options.company === 'invalid') {
    return { output: '', error: '无效公司 ID' };
  }

  // 获取角色列表
  let roles = mockRoles.filter(r => r.companyId === options.company);
  
  // 按级别过滤
  if (options.level) {
    const levelNum = parseInt(options.level.replace('L', ''), 10);
    roles = roles.filter(r => r.level === levelNum);
  }

  // 空列表
  if (roles.length === 0) {
    return { output: '无角色数据' };
  }

  // 格式化输出
  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify(roles, null, 2) };
  }
  
  if (format === 'csv') {
    const header = 'ID,Name,Type,Level,Workflows,Status';
    const rows = roles.map(r => `${r.id},${r.name},${r.type},L${r.level},${r.workflows.length},${r.status}`);
    return { output: `${header}\n${rows.join('\n')}` };
  }
  
  // table 格式
  const lines = ['ID | Name | Type | Level | Workflows | Status'];
  lines.push('-'.repeat(50));
  roles.forEach(r => {
    lines.push(`${r.id} | ${r.name} | ${r.type} | L${r.level} | ${r.workflows.length} | ${r.status}`);
  });
  return { output: `角色列表:\n${lines.join('\n')}` };
}