/**
 * Skill Extraction Service — 面向新架构 GoalExecution
 *
 * 从 GoalExecution 成功记录中提取可复用模式（Pattern）。
 * 这里的 "Skill" 不是旧 workflow 的 Execution 模式，
 * 而是"同类型任务在不同项目中反复成功"的可复用 prompt 模板。
 *
 * Migrated from Prisma Skill/SkillProposal to file-based stores (D-005).
 */
import { logger, recordDecision, FileStore, writeStudioEvent } from '@dommaker/studio-shared';
import { randomUUID } from 'crypto';
import { getSystemExecutor } from '../agents/system-executor.js';
import { skillStore } from './skill-store.js';
import { getSkillReviewAdapter, submitSkillProposal } from './review-adapter.js';

export interface ExtractedSkillProposal {
  id: string;
  skillId: string;
  companyId: string;
  name: string;
  description: string;
  category: string;
  pattern: string;
  sourceGoalIds: string[];
  confidence: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
}

export class SkillExtractionService {
  private fileStore: FileStore;

  constructor() {
    this.fileStore = new FileStore();
  }

  /** 从 WorkUnit 提取可复用模式 */
  async extractFromWorkUnit(workUnitId: string): Promise<ExtractedSkillProposal | null> {
    const snapshots = await this.fileStore.getIndex();
    const ge = snapshots.find(s => s.id === workUnitId);
    if (!ge || ge.status !== 'done') return null;

    const geMeta = ge.metadata ? JSON.parse(ge.metadata) : {};
    const goal = ge.parentId ? snapshots.find(s => s.id === ge.parentId) : null;
    const goalMeta = goal?.metadata ? JSON.parse(goal.metadata) : {};
    const companyId = goalMeta.companyId;
    if (!companyId) return null;

    const acGroup = geMeta.input?.acGroup;
    const acs = acGroup?.acs?.join(' ') || '';
    const files = acGroup?.files?.join(' ') || '';

    // 找同公司其他成功 WorkUnit children
    const companyGoals = snapshots.filter(s =>
      s.type === 'task' && s.parentId === null && s.status === 'done' &&
      (s.metadata?.includes(companyId) || false)
    ).slice(0, 20);
    const companyGoalIds = new Set(companyGoals.map(g => g.id));
    const similar = snapshots
      .filter(s => s.parentId !== null && companyGoalIds.has(s.parentId) && s.status === 'done' && s.id !== workUnitId)
      .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())
      .slice(0, 10)
      .map(s => ({ id: s.id, metadata: s.metadata }));
    if (similar.length < 1) return null;

    try {
      const similarParsed = similar.map(s => {
        const m = s.metadata ? JSON.parse(s.metadata) : {};
        return { acs: m.input?.acGroup?.acs?.join(' ') || '', output: m.output };
      });
      return await this.analyzeWithLLM(
        { acs, files, output: geMeta.output },
        similarParsed,
        companyId,
      );
    } catch (error) {
      logger.error('[SkillExtraction] Failed', { error: String(error) });
      return null;
    }
  }

  /** 跨项目扫描 Pattern */
  async scanForPatterns(companyId: string): Promise<ExtractedSkillProposal[]> {
    const snapshots = await this.fileStore.getIndex();

    // Parent goals: done/task/parentId=null, filtered by companyId in metadata
    const goals = snapshots
      .filter(s => s.status === 'done' && s.type === 'task' && s.parentId === null &&
        (s.metadata?.includes(companyId) || false))
      .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())
      .slice(0, 30);

    // For each goal, find up to 3 done children
    type GoalWithParsedChildren = { id: string; children: Array<{ id: string; input: any; output: any }> };
    const goalsParsed: GoalWithParsedChildren[] = goals.map(g => {
      const children = snapshots
        .filter(s => s.parentId === g.id && s.status === 'done')
        .slice(0, 3)
        .map(c => {
          const meta = c.metadata ? JSON.parse(c.metadata) : {};
          return { id: c.id, input: meta.input, output: meta.output };
        });
      return { id: g.id, children };
    });

    const proposals: ExtractedSkillProposal[] = [];
    const grouped = new Map<string, GoalWithParsedChildren[]>();
    for (const g of goalsParsed) {
      if (g.children.length < 2) continue;
      const key = g.children[0].input?.acGroup?.acs?.[0]?.slice(0, 30) || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(g);
    }

    for (const [, group] of grouped) {
      if (group.length < 2) continue;
      const main = group[0].children[0];
      try {
        const p = await this.analyzeWithLLM(
          { acs: main.input?.acGroup?.acs?.join('; ') || '', output: main.output },
          group.slice(1).map(g => ({ acs: g.children[0].input?.acGroup?.acs?.join('; ') || '', output: g.children[0].output })),
          companyId,
        );
        if (p && p.confidence >= 0.6) proposals.push(p);
      } catch (e) {
        logger.warn('[SkillExtraction] Skipping analysis failure', { error: String(e) });
      }
    }
    return proposals;
  }

  /** 保存 Skill 提案（含 auto-publish 逻辑） */
  async saveProposal(proposal: ExtractedSkillProposal): Promise<{ skillId: string; proposalId: string; autoPublished: boolean }> {
    const confidence = proposal.confidence || 0.5;
    const autoPublish = confidence >= 0.8;

    const skill = skillStore.create({
      companyId: proposal.companyId,
      name: proposal.name,
      description: proposal.description,
      category: proposal.category,
      source: 'auto_extracted',
      status: autoPublish ? 'published' : 'draft',
      metadata: JSON.stringify({ pattern: proposal.pattern, sourceGoalIds: proposal.sourceGoalIds, confidence }),
    });

    const spSummary = autoPublish
      ? `Auto-published (confidence: ${confidence.toFixed(2)} >= 0.8)`
      : `Pending review (confidence: ${confidence.toFixed(2)} < 0.8)`;

    // #354：提案存取/发卡归 review-proposal 正本（kind='skill'，skill-proposals.jsonl）。
    // autoPublish 无人工审批：提案行直接落 executed 终态（append-only，先 pending 后墓碑）。
    const proposalBase = {
      skillId: skill.id,
      name: proposal.name,
      description: proposal.description,
      category: proposal.category,
      confidence,
      sourceGoalIds: proposal.sourceGoalIds,
      proposedBy: 'system',
      summary: spSummary,
    };
    let proposalId: string;
    if (autoPublish) {
      proposalId = randomUUID();
      const adapter = getSkillReviewAdapter();
      await adapter.store.appendProposal({ ...proposalBase, id: proposalId, createdAt: new Date().toISOString() });
      await adapter.store.appendStatus(proposalId, 'executed');
    } else {
      const submitted = await submitSkillProposal(proposalBase);
      proposalId = submitted.proposalId;
      if (!submitted.posted) {
        logger.warn('[SkillExtraction] skill_review_request card not posted; proposal marked card-failed', {
          proposalId, name: proposal.name,
        });
      }
    }

    // S3 Gap 3c: emit skill_created for knowledge_skill_created metric
    // #361: 直写 appendJsonl 改统一入口 writeStudioEvent（知识事件默认 debug 级）
    void writeStudioEvent('knowledge:skill_created', {
      skillName: proposal.name,
      skillId: skill.id,
    }, { source: 'skill-extraction' });

    if (autoPublish) {
      logger.info('[SkillExtraction] Auto-published skill', {
        name: proposal.name,
        confidence,
        skillId: skill.id,
      });

      // Discord notification: Skill auto-publish
      try {
        const { discordNotifier } = await import('../../utils/discord-notifier.js');
        discordNotifier.sendText(
          'Skill auto-published',
          `**${proposal.name}** (${proposal.category})\nConfidence: ${(confidence * 100).toFixed(0)}%\nSource goals: ${proposal.sourceGoalIds.join(', ')}`
        ).catch(() => {});
      } catch (e) {
        logger.warn('[SkillExtraction] Discord notification failed (non-blocking)', { error: String(e) });
      }

      // Audit: Skill auto-publish
      try {
        recordDecision({
          eventType: 'skill.auto_published',
          entityType: 'skill',
          entityId: skill.id,
          companyId: proposal.companyId,
          summary: `Skill auto-published: ${proposal.name} (confidence: ${confidence.toFixed(2)})`,
          details: { name: proposal.name, category: proposal.category, confidence, sourceGoalIds: proposal.sourceGoalIds },
          actorRole: 'knowledge_keeper',
        });
      } catch (e) {
        logger.warn('[SkillExtraction] Audit recording failed (non-blocking)', { error: String(e) });
      }
    } else {
      logger.info('[SkillExtraction] Pending review proposal submitted', { proposalId, name: proposal.name });
    }

    return { skillId: skill.id, proposalId, autoPublished: autoPublish };
  }

  // 审批生命周期（reviewProposal）已删除：approve/reject 走 review-proposal 正本通用端点
  // /api/v1/review-proposals/skill/:id/{approve,reject,status}（#354，ADR 2026-08-25 决策 4）。

  async getPendingProposals(companyId: string) {
    const adapter = getSkillReviewAdapter();
    const pendingProposals = (await adapter.store.listProposals())
      .filter(p => p.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Filter by companyId via skill lookup
    return pendingProposals
      .map(p => {
        const skill = skillStore.get(p.skillId);
        if (!skill || skill.companyId !== companyId) return null;
        return { ...p, skill };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }

  // ─── Private ───

  private async analyzeWithLLM(
    main: { acs: string; files?: string; output: any },
    similar: Array<{ acs: string; output: any }>,
    companyId: string,
  ): Promise<ExtractedSkillProposal | null> {
    const prompt = `Analyze these Goal execution records for reusable patterns.

Goal execution AC: ${main.acs}${main.files ? '\nFiles: ' + main.files : ''}
Similar successful executions: ${similar.map((s, i) => `\n${i + 1}. ${s.acs}`).join('')}

Output JSON: {"hasPattern": bool, "name": "pattern name", "description": "description", "category": "code_gen|testing|review|refactor|config|docs", "pattern": "injectable Agent prompt template", "confidence": 0.8}`;

    const r = await getSystemExecutor().runJson<{ hasPattern: boolean; name?: string; description?: string; category?: string; pattern?: string; confidence?: number }>(prompt, { systemPrompt: 'You are a Skill extraction analyst.', eventSource: 'skill-extraction' });

    if (!r.hasPattern || !r.name) return null;
    return { id: '', skillId: '', companyId, name: r.name, description: r.description || '', category: r.category || 'general', pattern: r.pattern || '', sourceGoalIds: [], confidence: r.confidence || 0.5, status: 'pending', createdAt: new Date() };
  }
}

export const skillExtractionService = new SkillExtractionService();
