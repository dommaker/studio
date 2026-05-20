import type { SearchOptions, AuditLog } from '../types';

// Mock 数据
const mockLogs: AuditLog[] = [
  { id: '1', companyId: '1', action: 'create', actor: 'Alice', target: 'role-1', details: 'Created role Admin', timestamp: new Date('2026-01-15') },
  { id: '2', companyId: '1', action: 'update', actor: 'Bob', target: 'task-5', details: 'Updated task status', timestamp: new Date('2026-02-10') },
  { id: '3', companyId: '1', action: 'create', actor: 'Bob', target: 'role-2', details: 'Created role User', timestamp: new Date('2026-03-15') },
];

export async function runSearch(options: SearchOptions): Promise<{ output: string; error?: string }> {
  // 验证查询
  if (!options.query || options.query.trim() === '') {
    return { output: '', error: '查询内容不能为空' };
  }

  // 搜索日志
  const queryLower = options.query.toLowerCase();
  const results = mockLogs.filter(l => 
    l.companyId === options.company &&
    (l.details.toLowerCase().includes(queryLower) ||
     l.target.toLowerCase().includes(queryLower) ||
     l.action.toLowerCase().includes(queryLower))
  );

  if (results.length === 0) {
    return { output: `查询 "${options.query}" - 无匹配结果` };
  }

  const format = options.format || 'table';
  
  if (format === 'json') {
    return { output: JSON.stringify({ query: options.query, results, total: results.length }, null, 2) };
  }

  // table 格式
  const lines = [`Search Results for "${options.query}"`];
  results.forEach(l => {
    lines.push(`ID: ${l.id} | Action: ${l.action} | Details: ${l.details}`);
  });
  return { output: lines.join('\n') };
}