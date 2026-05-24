const { PrismaClient } = require('@dommaker/studio-prisma');
const prisma = new PrismaClient();

async function main() {
  // Find a valid project and company
  const project = await prisma.project.findFirst({ select: { id: true, companyId: true, pmoNumber: true } });
  if (!project) { console.log('No project found'); return; }
  const { id: projectId, companyId } = project;
  console.log(`Using project: ${projectId}, company: ${companyId}`);

  const docs = [
    { type: 'design', title: 'Plan Coverage via PostEval', content: 'Pre-commit hook 验证 plan.md checklist items 和 staged diff 的覆盖率。复用 PostEval AC 提取 + LLM 语义匹配引擎。文件: post-eval-agent.service.ts, harness posteval-plan CLI, studio pre-commit hook。', tags: '["plan-coverage","posteval","pre-commit"]' },
    { type: 'design', title: 'Pipeline Logging & Observability Audit', content: '全管线 9 阶段 + 2 后台 Agent 日志补齐。每阶段增加: duration, token consumption(含 cacheHit), recordPipelineRun(), knowledgeBus.recordPattern()。Metrics.phase 扩展: analyst/executor/review/deploy/full。', tags: '["pipeline","logging","observability"]' },
    { type: 'design', title: 'KnowledgeStore Breakpoint Fixes', content: '17 断点中发现 5 个已修复: BP-17 单例 store, BP-4 引用追踪, BP-2 lastReferenced 初始化, BP-1 可信来源 verified。新增电路自检+自愈+新鲜度追踪。', tags: '["knowledgestore","breakpoints","circuit-check"]' },
    { type: 'design', title: 'Knowledge Circuit Self-Check & Auto-Repair', content: '4 条电路 (Write→Read, Read→Promote, Promote→Validate, Decay→Archive) + DocFreshness。因果推断而非阈值检测，逐 entry 追跃迁链。MonitorAgent 启动+每小时触发。', tags: '["knowledge-circuit","self-check","auto-repair"]' },
    { type: 'design', title: 'Knowledge Types: Pattern vs Document', content: '两种知识类型: Pattern (运行时事件, 短, prompt注入, recordPattern) vs Document (设计分析, 长, 供查询, upsertKnowledge)。设计时沉淀目前手动，缺 API 端点和 Analyst 自动调用。', tags: '["knowledge-types","design-time","architecture"]' },
  ];

  for (const doc of docs) {
    const created = await prisma.document.create({
      data: { projectId, companyId, ...doc, status: 'active', version: 1, createdBy: 'analyst' }
    });
    console.log(`  Created: ${created.id.slice(0,8)} — ${created.title}`);
  }

  console.log('Done');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
