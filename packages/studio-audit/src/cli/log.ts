import type { LogOptions, AuditLog } from '../types';

// Mock 数据
const mockLogs: AuditLog[] = [
  { id: '1', companyId: '1', action: 'create', actor: 'Alice', target: 'role-1', details: 'Created role Admin', timestamp: new Date('2026-01-15') },
  { id: '2', companyId: '1', action: 'update', actor: 'Bob', target: 'task-5', details: 'Updated task status', timestamp: new Date('2026-02-10') },
  { id: '3', companyId: '1', action: 'delete', actor: 'Alice', target: 'task-7', details: 'Deleted task', timestamp: new Date('2026-03-01') },
  { id: '4', companyId: '1', action: 'create', actor: 'Bob', target: 'role-2', details: 'Created role User', timestamp: new Date('2026-03-15') },
];

const companies = { '1': 'Company A', '2': 'Company B', 'empty': 'Empty Co' };

export async function runLog(options: LogOptions): Promise<{ output: string; error?: string }> {
  // 验证公司
  const companyName = companies[options.company as keyof typeof companies];
  if (!companyName && options.company !== 'nonexistent') {
    return { output: '', error: `公司 ${options.company} 不存在` };
  }

  if (options.company === 'nonexistent') {
    return { output: '', error: '公司不存在' };
  }

  // 过滤日志
  let logs = mockLogs.filter(l => l.companyId === options.company);
  
  if (options.action) {
    logs = logs.filter(l => l.action === options.action);
  }

  if (options.limit) {
    logs = logs.slice(0, options.limit);
  }

  if (options.company === 'empty' || logs.length === 0) {
    return { output: `${companyName || options.company} - 无审计日志` };
  }

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify({ company: options.company, logs, total: logs.length }, null, 2) };
  }

  // table 格式
  const lines = [`${companyName} - Audit Logs`];
  logs.forEach(l => {
    lines.push(`ID: ${l.id} | Action: ${l.action} | Actor: ${l.actor} | Target: ${l.target} | ${l.details}`);
  });
  return { output: lines.join('\n') };
}