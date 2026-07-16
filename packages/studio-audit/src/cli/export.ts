import type { ExportOptions, AuditLog } from '../types';

// Mock 数据
const mockLogs: AuditLog[] = [
  { id: '1', companyId: '1', action: 'create', actor: 'Alice', target: 'role-1', details: 'Created role', timestamp: new Date('2026-01-15') },
  { id: '2', companyId: '1', action: 'update', actor: 'Bob', target: 'task-5', details: 'Updated task', timestamp: new Date('2026-02-10') },
  { id: '3', companyId: '1', action: 'delete', actor: 'Alice', target: 'task-7', details: 'Deleted task', timestamp: new Date('2026-03-01') },
];

const companies = { '1': 'Company A', 'empty': 'Empty Co' };

function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export async function runExport(options: ExportOptions): Promise<{ output: string; error?: string }> {
  // 验证日期
  if (!isValidDate(options.from) || !isValidDate(options.to)) {
    return { output: '', error: '无效日期格式，应为 YYYY-MM-DD' };
  }

  const companyName = companies[options.company as keyof typeof companies];
  
  // 过滤日志
  let logs = mockLogs.filter(l => l.companyId === options.company);
  const fromDate = new Date(options.from);
  const toDate = new Date(options.to);
  logs = logs.filter(l => l.timestamp >= fromDate && l.timestamp <= toDate);

  if (options.company === 'empty' || logs.length === 0) {
    return { output: `${companyName || options.company} - 无审计日志` };
  }

  const format = options.format || 'csv';
  
  if (format === 'json') {
    return { output: JSON.stringify({ exported: logs.length, from: options.from, to: options.to, logs }, null, 2) };
  }

  // csv 格式
  const lines = ['ID,Company,Action,Actor,Target,Details,Date'];
  logs.forEach(l => {
    const date = l.timestamp.toISOString().split('T')[0];
    lines.push(`${l.id},${l.companyId},${l.action},${l.actor},${l.target},${l.details},${date}`);
  });
  return { output: `Exported ${logs.length} audit logs\n${lines.join('\n')}` };
}