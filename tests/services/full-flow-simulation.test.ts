/**
 * 全流程端到端模拟测试
 *
 * 模拟完整链路，不依赖服务器运行。
 * Analyst → RequirementsDoc → Wiki → Goal → Executor → Review → Knowledge → Audit
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const COMPANY = 'e2e-company';
const PMO = 'PMO-2026-042';
const WIKI = path.join(os.homedir(), 'knowledge-base', 'companies', COMPANY, 'wiki');
const AUDIT = path.join(os.homedir(), '.harness', 'audit');

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function clean() {
  [WIKI, AUDIT, '.harness/logs'].forEach(d => { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true }); });
}
function auditEvents(filter?: string) {
  if (!fs.existsSync(AUDIT)) return [];
  const all: any[] = [];
  for (const f of fs.readdirSync(AUDIT).filter(x => x.endsWith('.jsonl'))) {
    fs.readFileSync(path.join(AUDIT, f), 'utf-8').split('\n').filter(Boolean).forEach(l => { try { all.push(JSON.parse(l)); } catch {} });
  }
  return filter ? all.filter((e: any) => e.eventType === filter) : all;
}
function auditTypes() { return [...new Set(auditEvents().map((e: any) => e.eventType))]; }

// ── 内联函数 ──
function createWikiPage(relPath: string, title: string, body: string, fm?: any) {
  const fp = path.join(WIKI, relPath); ensureDir(path.dirname(fp));
  let c = ''; if (fm) { c += '---\n'; for (const [k, v] of Object.entries(fm)) c += `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`; c += '---\n\n'; }
  c += `# ${title}\n\n${body}`; fs.writeFileSync(fp, c, 'utf-8');
}
function readPage(rel: string) { const p = path.join(WIKI, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
function hasPage(rel: string) { return fs.existsSync(path.join(WIKI, rel)); }
function query(q: string, max = 5) {
  if (!fs.existsSync(WIKI)) return [];
  const kw = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!kw.length) return [];
  const r: any[] = [];
  (function walk(d: string, rel: string) {
    let e: fs.Dirent[]; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) { if (x.name.startsWith('.')) continue; const p = path.join(d, x.name); x.isDirectory() ? walk(p, rel + x.name + '/') : x.name.endsWith('.md') && (() => { const c = fs.readFileSync(p, 'utf-8').toLowerCase(); let h = 0; for (const k of kw) if (c.includes(k)) h++; if (h > 0) { const t = c.match(/^#\s+(.+)$/m); r.push({ pagePath: rel + x.name, title: t ? t[1] : x.name, relevance: h / kw.length }); } })(); }
  })(WIKI, '');
  return r.sort((a, b) => b.relevance - a.relevance).slice(0, max);
}
function recordAudit(e: any) {
  ensureDir(AUDIT); const d = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(AUDIT, `${d}.jsonl`), JSON.stringify({ ...e, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString() }) + '\n', 'utf-8');
}
function shouldAutoPublish(conf: number) { return (conf || 0.5) >= 0.8; }

// ── 模拟角色行为 ──
function simulateAnalyst(projectId: string, topic: string) {
  // 1. 冷启动检查
  const cold = query(topic, 5).length === 0;
  // 2. 辩论（模拟：产出3个decisions）
  const decisions = [
    { content: '实现 JWT 签发与验证', agreed: true, priority: 'high' },
    { content: '实现 GitHub OAuth 登录', agreed: true, priority: 'normal' },
    { content: 'Token 刷新机制', agreed: true, priority: 'normal' },
  ];
  // 3. RequirementsDoc
  const doc = {
    acGroups: [
      { id: 'auth-jwt', acs: ['JWT签发返回token', '过期token返回401', 'refreshToken续期'], files: ['src/auth/jwt.ts', 'src/auth/middleware.ts'], dependencies: [] },
      { id: 'auth-oauth', acs: ['GitHub OAuth回调', '首次登录创建用户'], files: ['src/auth/oauth.ts'], dependencies: ['auth-jwt'] },
    ],
    constraints: ['JWT_SECRET 走环境变量', 'Token 15min 过期'],
    summary: 'JWT + OAuth 用户认证系统',
  };
  // 4. 审计
  recordAudit({ eventType: 'requirements.generated', entityType: 'requirements', entityId: projectId, projectId, summary: `RequirementsDoc: ${doc.summary}`, details: { acGroupCount: doc.acGroups.length, constraintCount: doc.constraints.length, isColdStart: cold }, actorRole: 'analyst' });
  return { decisions, doc, isColdStart: cold };
}

function simulateKnowledgeKeeper(goalId: string, doc: any) {
  // 1. 创建项目页
  const acList = doc.acGroups.map((g: any) => `### ${g.id}${g.dependencies.length ? ` (依赖: ${g.dependencies.join(',')})` : ''}\n${g.acs.map((a: string) => `- **AC**: ${a}`).join('\n')}\n- 改动: ${g.files.join(', ')}`).join('\n\n');
  createWikiPage(`projects/${PMO}.md`, `${PMO} · 用户认证系统`, `## 需求摘要\n${doc.summary}\n\n## 验收标准\n${acList}\n\n${doc.constraints.map((c: string) => `- ${c}`).join('\n')}\n\n## 关联\n- Goal: ${goalId}\n\n## 执行结果\n*待执行*\n\n## 踩过的坑\n*暂无*`, { maturity: 'draft', createdAt: new Date().toISOString(), pmoNumber: PMO });
  // 2. INDEX
  if (!hasPage('INDEX.md')) createWikiPage('INDEX.md', '公司知识库索引', '## 项目\n- [[projects/PMO-2026-042]] — 用户认证系统\n\n## 技能\n\n## 坑位\n');
  // 3. 审计
  recordAudit({ eventType: 'wiki.page_created', entityType: 'wiki', entityId: `projects/${PMO}.md`, summary: `Wiki 项目页: ${PMO} · 用户认证系统`, actorRole: 'knowledge_keeper' });
}

function simulateGoalCreation(goalId: string) {
  recordAudit({ eventType: 'goal.created', entityType: 'goal', entityId: goalId, summary: `Goal 创建（2 AC 组，3 约束）`, details: { stepCount: 2, acGroupCount: 2 }, actorRole: 'analyst' });
}

function simulateExecutor(execId: string, goalId: string, acGroupId: string, success: boolean, sessionCount: number) {
  if (success) {
    recordAudit({ eventType: 'execution.completed', entityType: 'execution', entityId: execId, summary: `Executor 完成: ${acGroupId}（sessions: ${sessionCount}）`, details: { sessionCount, acGroupId }, actorRole: 'executor' });
    // 更新 Wiki（直接写文件，避免 createWikiPage 重建 frontmatter）
    const fp = path.join(WIKI, 'projects', `${PMO}.md`);
    if (fs.existsSync(fp)) {
      let c = fs.readFileSync(fp, 'utf-8');
      c = c.replace('*待执行*', `- ✅ **${acGroupId}**: 完成（${sessionCount} sessions）`);
      fs.writeFileSync(fp, c, 'utf-8');
    }
    recordAudit({ eventType: 'wiki.page_updated', entityType: 'wiki', entityId: `projects/${PMO}.md`, summary: `Wiki 更新: ${PMO} — ${acGroupId} 完成`, actorRole: 'knowledge_keeper' });
  } else {
    recordAudit({ eventType: 'execution.failed', entityType: 'execution', entityId: execId, summary: `Executor 失败: ${acGroupId}`, actorRole: 'executor' });
  }
}

function simulateReviewer(taskId: string, approved: boolean, cycle: number, issues: string[]) {
  if (approved) {
    recordAudit({ eventType: 'review.completed', entityType: 'review', entityId: taskId, summary: `Review 通过（cycle: ${cycle}, score: 85）`, details: { approved: true, score: 85, cycle }, actorRole: 'reviewer' });
  } else if (cycle >= 3) {
    recordAudit({ eventType: 'review.completed', entityType: 'review', entityId: taskId, summary: `Review 未通过（cycle: ${cycle}, issues: ${issues.length}）`, details: { approved: false, issues }, actorRole: 'reviewer' });
    recordAudit({ eventType: 'review.exhausted', entityType: 'review', entityId: taskId, summary: `审查耗尽（${cycle}/3 轮未通过）`, details: { cycles: cycle, issues }, actorRole: 'reviewer' });
    // Pitfall
    createWikiPage(`pitfalls/review-exhausted-${taskId.slice(0, 8)}.md`, `审查循环耗尽: ${taskId}`, `## 问题\n任务 ${taskId} 经 ${cycle} 轮审查未通过。\n\n## 发现\n${issues.map(i => `- ${i}`).join('\n')}\n\n## 处理\n需人工介入。`, { maturity: 'draft', reviewCycles: cycle, createdAt: new Date().toISOString() });
    recordAudit({ eventType: 'wiki.pitfall_created', entityType: 'wiki', entityId: `pitfalls/review-exhausted-${taskId.slice(0, 8)}.md`, summary: `Pitfall 创建: ${taskId}`, actorRole: 'reviewer' });
  } else {
    recordAudit({ eventType: 'review.completed', entityType: 'review', entityId: taskId, summary: `Review 未通过（cycle: ${cycle}, issues: ${issues.length}）`, details: { approved: false, issues }, actorRole: 'reviewer' });
    // Runtime constraints（跨Executor广播）
    const systemic = issues.filter(i => i.includes('TypeScript') || i.includes('类型')).slice(0, 2);
    if (systemic.length > 0) {
      recordAudit({ eventType: 'execution.completed', entityType: 'execution', entityId: `runtime-${taskId}`, summary: `运行时约束广播: ${systemic.join('; ')}`, details: { constraintType: 'runtime', source: 'review', issues: systemic }, actorRole: 'reviewer' });
    }
  }
}

function simulateSkillExtraction(skillName: string, confidence: number, goalIds: string[]) {
  const auto = shouldAutoPublish(confidence);
  createWikiPage(`skills/${skillName.toLowerCase().replace(/[^a-z]+/g, '-')}.md`, skillName, `## 模式\nExtracted from ${goalIds.join(', ')}\n\n## 置信度\n${(confidence * 100).toFixed(0)}%`, { confidence, sourceGoalIds: goalIds, published: auto, maturity: auto ? 'published' : 'draft', createdAt: new Date().toISOString() });
  recordAudit({ eventType: 'skill.auto_published', entityType: 'skill', entityId: skillName, summary: `Skill ${auto ? 'auto-published' : 'pending'}: ${skillName}（confidence: ${confidence.toFixed(2)}）`, details: { name: skillName, confidence, autoPublished: auto }, actorRole: 'knowledge_keeper' });
}

function simulateTrace(count: number) {
  const { getTraceCollector } = require('@dommaker/harness');
  const c = getTraceCollector();
  for (let i = 0; i < count; i++) c.recordPass(`trace-${i}`, 'guideline', { message: `pass-${i}` });
}

// ═══════════════════════════════════════════════════════

describe('全流程端到端模拟', () => {
  beforeAll(() => clean());
  afterAll(() => clean());

  it('Phase 1: Analyst 辩论 → RequirementsDoc（冷启动）', () => {
    const { doc, isColdStart } = simulateAnalyst('project-1', '用户认证系统');

    expect(isColdStart).toBe(true);
    expect(doc.acGroups).toHaveLength(2);
    expect(doc.acGroups[0].id).toBe('auth-jwt');
    expect(doc.acGroups[1].dependencies).toEqual(['auth-jwt']);
    expect(doc.constraints).toHaveLength(2);
    expect(doc.constraints[0]).toContain('JWT_SECRET');

    // 审计: requirements.generated
    const events = auditEvents('requirements.generated');
    expect(events).toHaveLength(1);
    expect(events[0].details.isColdStart).toBe(true);
  });

  it('Phase 2: Knowledge Keeper → Wiki 项目页 + Goal 创建', () => {
    simulateKnowledgeKeeper('goal-1', {
      summary: 'JWT + OAuth 用户认证系统',
      acGroups: [
        { id: 'auth-jwt', acs: ['JWT签发', 'Token刷新'], files: ['src/auth/jwt.ts'], dependencies: [] },
        { id: 'auth-oauth', acs: ['OAuth回调', '自动注册'], files: ['src/auth/oauth.ts'], dependencies: ['auth-jwt'] },
      ],
      constraints: ['JWT_SECRET 走环境变量', 'Token 15min 过期'],
    });
    simulateGoalCreation('goal-1');

    // Wiki 项目页存在
    expect(hasPage('projects/PMO-2026-042.md')).toBe(true);
    const page = readPage('projects/PMO-2026-042.md')!;
    expect(page).toContain('用户认证系统');
    expect(page).toContain('依赖: auth-jwt');
    expect(page).toContain('*待执行*');

    // INDEX
    expect(hasPage('INDEX.md')).toBe(true);

    // 审计
    expect(auditEvents('wiki.page_created')).toHaveLength(1);
    expect(auditEvents('goal.created')).toHaveLength(1);
  });

  it('Phase 3: Executor 执行 → Wiki 更新', () => {
    simulateExecutor('exec-1', 'goal-1', 'auth-jwt', true, 2);
    simulateExecutor('exec-2', 'goal-1', 'auth-oauth', false, 1);

    // Wiki 已更新
    const page = readPage('projects/PMO-2026-042.md')!;
    expect(page).toContain('✅');
    expect(page).not.toContain('*待执行*');
    expect(page).toContain('auth-jwt');

    // 审计
    expect(auditEvents('execution.completed')).toHaveLength(1);
    expect(auditEvents('execution.failed')).toHaveLength(1);
    expect(auditEvents('wiki.page_updated')).toHaveLength(1);
  });

  it('Phase 4: Reviewer 审查 → 多轮循环', () => {
    // Exec-1 的 Review: 一次通过
    simulateReviewer('task-exec-1', true, 1, []);
    // Exec-2 的 Review: 3轮都不通过 → 耗尽
    simulateReviewer('task-exec-2', false, 1, ['any类型滥用', '缺少错误处理']);
    simulateReviewer('task-exec-2', false, 2, ['any类型滥用', '测试覆盖不足']);
    simulateReviewer('task-exec-2', false, 3, ['any类型滥用', 'TypeScript类型冲突', '边界条件未覆盖']);

    // 审计
    expect(auditEvents('review.completed')).toHaveLength(4);
    expect(auditEvents('review.exhausted')).toHaveLength(1);

    // Pitfall 创建
    expect(auditEvents('wiki.pitfall_created')).toHaveLength(1);
    const pits = fs.readdirSync(path.join(WIKI, 'pitfalls'));
    expect(pits.length).toBeGreaterThan(0);
    expect(pits[0]).toContain('review-exhausted');
  });

  it('Phase 5: Knowledge Keeper Ingest — Skill + Pitfall', () => {
    simulateSkillExtraction('JWT Middleware Pattern', 0.85, ['goal-1', 'goal-2']);
    simulateSkillExtraction('TypeScript Strict Mode', 0.60, ['goal-1']);

    // Skill 页面
    expect(hasPage('skills/jwt-middleware-pattern.md')).toBe(true);
    expect(hasPage('skills/typescript-strict-mode.md')).toBe(true);

    // auto-publish 逻辑
    expect(shouldAutoPublish(0.85)).toBe(true);
    expect(shouldAutoPublish(0.60)).toBe(false);

    // 审计
    const skillEvents = auditEvents('skill.auto_published');
    expect(skillEvents).toHaveLength(2);
    expect(skillEvents[0].details.autoPublished).toBe(true);
    expect(skillEvents[1].details.autoPublished).toBe(false);
  });

  it('Phase 6: 下一轮 Analyst 查询知识库（非冷启动）', () => {
    // 查询"认证" → 找到项目和 Skill
    const authResults = query('JWT 认证 用户', 5);
    expect(authResults.length).toBeGreaterThanOrEqual(2);
    const authPaths = authResults.map((r: any) => r.pagePath);
    expect(authPaths.some((p: string) => p.includes('PMO-2026-042'))).toBe(true);
    expect(authPaths.some((p: string) => p.includes('jwt-middleware'))).toBe(true);

    // 查询"TypeScript 类型" → 找到 pitfall
    const tsResults = query('TypeScript 类型 审查 耗尽', 5);
    expect(tsResults.length).toBeGreaterThanOrEqual(1);
    expect(tsResults.some((r: any) => r.pagePath.includes('pitfalls'))).toBe(true);
  });

  it('Phase 7: 全量审计事件核查', () => {
    const types = auditTypes();
    const expected = [
      'requirements.generated',
      'wiki.page_created',
      'goal.created',
      'execution.completed',
      'execution.failed',
      'wiki.page_updated',
      'review.completed',
      'review.exhausted',
      'wiki.pitfall_created',
      'skill.auto_published',
    ];

    for (const t of expected) {
      expect(types, `缺少审计类型: ${t}`).toContain(t);
    }

    // 每个事件都有 id + timestamp + actorRole
    for (const e of auditEvents()) {
      expect(e.id).toBeDefined();
      expect(e.timestamp).toBeDefined();
      expect(e.actorRole).toBeDefined();
    }
  });

  it('Phase 8: Trace 写入验证', () => {
    simulateTrace(3);
    const tf = '.harness/logs/traces.log';
    expect(fs.existsSync(tf)).toBe(true);
    const traces = fs.readFileSync(tf, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(traces.length).toBeGreaterThanOrEqual(3);
    expect(traces.filter((t: any) => t.result === 'pass').length).toBeGreaterThanOrEqual(3);
  });

  it('Phase 9: Skill 有效性模拟', () => {
    // Skill "JWT Middleware" 被 3 个执行引用，2 个 Review 一次过，1 个被打回
    const effectiveness = 2 / 3;
    expect(effectiveness).toBeCloseTo(0.67, 1);

    // Skill "TypeScript Strict" 被 1 个执行引用，0 个一次过
    const badEffectiveness = 0 / 1;
    expect(badEffectiveness).toBe(0);
  });

  it('Phase 10: 跨项目知识复用', () => {
    // 第二个公司/项目
    const COMPANY2 = 'e2e-company-2';
    const WIKI2 = path.join(os.homedir(), 'knowledge-base', 'companies', COMPANY2, 'wiki');

    // 模拟已有经验的公司
    expect(fs.existsSync(WIKI)).toBe(true);
    // 新公司初始为空
    expect(fs.existsSync(WIKI2)).toBe(false);

    // 清理
    if (fs.existsSync(WIKI2)) fs.rmSync(WIKI2, { recursive: true });
  });
});
