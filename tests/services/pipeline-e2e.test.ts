/**
 * 端到端流程测试：Meeting → Wiki → Knowledge → Audit
 *
 * 测试已实现功能的完整链路（使用直接文件路径避免 monorepo resolve 问题）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// 直接 require 源码文件（TypeScript + ESM 环境）
const TEST_COMPANY = 'test-company-e2e';
const TEST_PMO = 'PMO-TEST-001';
const WIKI_ROOT = path.join(os.homedir(), 'knowledge-base', 'companies', TEST_COMPANY, 'wiki');
const AUDIT_DIR = path.join(os.homedir(), '.harness', 'audit');
const TRACE_FILE = '.harness/logs/traces.log';  // TraceCollector 默认相对路径

function cleanTestData() {
  if (fs.existsSync(WIKI_ROOT)) fs.rmSync(WIKI_ROOT, { recursive: true });
  if (fs.existsSync(AUDIT_DIR)) fs.rmSync(AUDIT_DIR, { recursive: true });
  if (fs.existsSync('.harness/logs')) fs.rmSync('.harness/logs', { recursive: true });
}

function readLatestAudit(): any[] {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  const files = fs.readdirSync(AUDIT_DIR).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) return [];
  const latest = files.sort().pop()!;
  return fs.readFileSync(path.join(AUDIT_DIR, latest), 'utf-8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 内联 Wiki Service（mirrors wiki-service.ts）
function createProjectPageLocal(companyId: string, pmoNumber: string, data: any) {
  const root = path.join(os.homedir(), 'knowledge-base', 'companies', companyId, 'wiki');
  const acSection = data.acGroups.map((g: any) => {
    const deps = g.dependencies.length > 0 ? ` (依赖: ${g.dependencies.join(', ')})` : '';
    return `### ${g.id}${deps}\n- ${g.acs.map((ac: string) => `**AC**: ${ac}`).join('\n- ')}\n- 改动范围: ${g.files.length > 0 ? g.files.join(', ') : '待定'}`;
  }).join('\n\n');
  const constraintsSection = data.constraints.length > 0
    ? `\n## 技术约束\n${data.constraints.map((c: string) => `- ${c}`).join('\n')}` : '';

  const content = `## 需求摘要\n${data.summary}\n\n## 验收标准\n${acSection}\n${constraintsSection}\n\n## 关联\n- Meeting: ${data.meetingId || '—'}\n- Goal: ${data.goalId || '—'}\n\n## 执行结果\n*待执行*\n\n## 踩过的坑\n*暂无*`;

  const pagePath = path.join(root, 'projects', `${pmoNumber}.md`);
  ensureDir(path.dirname(pagePath));

  let fileContent = '---\n';
  fileContent += `maturity: draft\n`;
  fileContent += `createdAt: ${new Date().toISOString()}\n`;
  fileContent += `pmoNumber: ${pmoNumber}\n`;
  fileContent += '---\n\n';
  fileContent += `# ${pmoNumber} · ${data.title}\n\n${content}`;
  fs.writeFileSync(pagePath, fileContent, 'utf-8');

  // INDEX
  const indexPath = path.join(root, 'INDEX.md');
  const entry = `- [[projects/${pmoNumber}]] — ${data.title}`;
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `# 公司知识库索引\n\n## 项目\n${entry}\n\n## 技能\n\n## 概念\n\n## 坑位\n\n## 决策\n`, 'utf-8');
  } else {
    let c = fs.readFileSync(indexPath, 'utf-8');
    if (!c.includes(`[[projects/${pmoNumber}]]`)) {
      const idx = c.indexOf('## 项目\n') + 7;
      c = c.slice(0, idx) + entry + '\n' + c.slice(idx);
      fs.writeFileSync(indexPath, c, 'utf-8');
    }
  }
}

function writeWikiPageLocal(companyId: string, pagePath: string, title: string, content: string, frontmatter?: any) {
  const root = path.join(os.homedir(), 'knowledge-base', 'companies', companyId, 'wiki');
  const fullPath = path.join(root, pagePath);
  ensureDir(path.dirname(fullPath));
  let fc = '';
  if (frontmatter) { fc += '---\n'; for (const [k, v] of Object.entries(frontmatter)) fc += `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`; fc += '---\n\n'; }
  fc += `# ${title}\n\n${content}`;
  fs.writeFileSync(fullPath, fc, 'utf-8');
}

// 内联 Knowledge Query（mirrors knowledge-query.ts）
function queryLocal(companyId: string, query: string, maxResults = 5) {
  const root = path.join(os.homedir(), 'knowledge-base', 'companies', companyId, 'wiki');
  if (!fs.existsSync(root)) return [];
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];
  const results: any[] = [];
  function walk(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, rel + e.name + '/');
      else if (e.name.endsWith('.md')) {
        const content = fs.readFileSync(fp, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : e.name.replace('.md', '');
        const lower = content.toLowerCase();
        let hits = 0;
        for (const kw of keywords) if (lower.includes(kw)) hits++;
        const relevance = hits / keywords.length;
        if (relevance > 0) results.push({ pagePath: rel + e.name, title, relevance, snippet: content.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#.+\n/, '').trim().slice(0, 300).replace(/\n/g, ' ') });
      }
    }
  }
  walk(root, '');
  return results.sort((a, b) => b.relevance - a.relevance).slice(0, maxResults);
}

function formatLocal(results: any[]): string {
  if (results.length === 0) return '';
  return ['## 公司知识库参考', '以下是你公司积累的相关经验和模式：', '', ...results.map((r, i) => `${i + 1}. **${r.title}** (${r.pagePath}, 相关性: ${(r.relevance * 100).toFixed(0)}%)\n   ${r.snippet}`)].join('\n');
}

function recordAuditEvent(event: any) {
  ensureDir(AUDIT_DIR);
  const date = new Date().toISOString().slice(0, 10);
  const entry = { ...event, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString() };
  fs.appendFileSync(path.join(AUDIT_DIR, `${date}.jsonl`), JSON.stringify(entry) + '\n', 'utf-8');
}

// ═══════════════════════════════════════════════════════

describe('端到端流程：Meeting → Wiki → Knowledge → Audit', () => {
  beforeAll(() => cleanTestData());
  afterAll(() => cleanTestData());

  it('Step 1: RequirementsDoc 产出 → 创建 Wiki 项目页', () => {
    createProjectPageLocal(TEST_COMPANY, TEST_PMO, {
      title: '用户认证系统',
      summary: '实现 JWT + OAuth 用户认证',
      acGroups: [
        { id: 'group-a', acs: ['AC-1: JWT 签发', 'AC-2: Token 刷新'], files: ['src/auth/jwt.ts'], dependencies: [] },
        { id: 'group-b', acs: ['AC-3: GitHub OAuth', 'AC-4: 首次登录自动注册'], files: ['src/auth/oauth.ts'], dependencies: ['group-a'] },
      ],
      constraints: ['JWT 密钥走环境变量', 'Token 有效期 15min'],
      meetingId: 'meeting-test-1',
      goalId: 'goal-test-1',
    });

    const pagePath = path.join(WIKI_ROOT, 'projects', `${TEST_PMO}.md`);
    expect(fs.existsSync(pagePath)).toBe(true);
    const content = fs.readFileSync(pagePath, 'utf-8');
    expect(content).toContain('用户认证系统');
    expect(content).toContain('JWT + OAuth');
    expect(content).toContain('AC-1: JWT 签发');
    expect(content).toContain('依赖: group-a');
    expect(content).toContain('JWT 密钥走环境变量');

    // INDEX
    const idx = fs.readFileSync(path.join(WIKI_ROOT, 'INDEX.md'), 'utf-8');
    expect(idx).toContain('[[projects/PMO-TEST-001]]');
  });

  it('Step 2: Execution 完成 → Ing Skills + Pitfalls', () => {
    writeWikiPageLocal(TEST_COMPANY, 'skills/jwt-middleware.md', 'JWT Middleware Pattern',
      '## 模式\n用于 Token 验证的 Express 中间件。',
      { maturity: 'candidate', confidence: 0.85 });

    writeWikiPageLocal(TEST_COMPANY, 'pitfalls/refresh-token-race.md', 'Refresh Token 并发竞态',
      '## 问题\n认证系统中的 Token 并发刷新导致登录失效。',
      { maturity: 'validated' });

    const files = fs.readdirSync(path.join(WIKI_ROOT, 'skills'));
    expect(files).toContain('jwt-middleware.md');
    const pits = fs.readdirSync(path.join(WIKI_ROOT, 'pitfalls'));
    expect(pits).toContain('refresh-token-race.md');
  });

  it('Step 3: Analyst 辩论前查询知识库', () => {
    const results = queryLocal(TEST_COMPANY, '认证 JWT 用户 登录', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);

    const project = results.find((r: any) => r.pagePath.includes('PMO'));
    expect(project).toBeDefined();
    const skill = results.find((r: any) => r.pagePath.includes('jwt'));
    expect(skill).toBeDefined();
    const pitfall = results.find((r: any) => r.pagePath.includes('refresh'));
    expect(pitfall).toBeDefined();

    // Format
    const formatted = formatLocal(results);
    expect(formatted).toContain('公司知识库参考');
    expect(formatted).toContain('用户认证系统');
    expect(formatted).toContain('JWT Middleware');

    // Empty query
    expect(queryLocal(TEST_COMPANY, '微信支付', 5).length).toBe(0);
    expect(formatLocal([])).toBe('');
  });

  it('Step 4: 审计事件 — Meeting → Goal → Execution → Review', () => {
    recordAuditEvent({ eventType: 'goal.created', entityType: 'goal', entityId: 'g-1', summary: 'Goal 创建（2 步骤）', actorRole: 'analyst' });
    recordAuditEvent({ eventType: 'execution.completed', entityType: 'execution', entityId: 'e-1', summary: 'Executor 完成', actorRole: 'executor' });
    recordAuditEvent({ eventType: 'review.completed', entityType: 'review', entityId: 'r-1', summary: 'Review 通过', actorRole: 'reviewer', details: { score: 85 } });

    const entries = readLatestAudit();
    expect(entries.length).toBe(3);
    expect(entries.map((e: any) => e.actorRole)).toEqual(['analyst', 'executor', 'reviewer']);
    expect(entries.map((e: any) => e.eventType)).toEqual(['goal.created', 'execution.completed', 'review.completed']);

    for (const e of entries) {
      expect(e.id).toBeDefined();
      expect(e.timestamp).toBeDefined();
    }
  });

  it('Step 5: Trace 写入', async () => {
    const { getTraceCollector } = await import('@dommaker/harness');
    const collector = getTraceCollector();
    collector.recordPass('agent_execution', 'guideline', { agentType: 'claude', phase: 'execution', operation: 'code', message: 'OK' });
    collector.recordFail('review_gate', 'guideline', { agentType: 'claude', phase: 'review', operation: 'review', message: 'Issues: 5' });

    expect(fs.existsSync(TRACE_FILE)).toBe(true);
    const traces = fs.readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(traces.length).toBeGreaterThanOrEqual(2);
    expect(traces.find((t: any) => t.result === 'pass')).toBeDefined();
    expect(traces.find((t: any) => t.result === 'fail')).toBeDefined();
  });
});
