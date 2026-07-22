/**
 * Skill Extraction Service — 面向新架构 GoalExecution
 *
 * 从 GoalExecution 成功记录中提取可复用模式（Pattern）。
 * 这里的 "Skill" 不是旧 workflow 的 Execution 模式，
 * 而是"同类型任务在不同项目中反复成功"的可复用 prompt 模板。
 *
 * Migrated from Prisma Skill/SkillProposal to file-based stores (D-005).
 */
import { logger, recordDecision, FileStore } from '@dommaker/studio-shared';
import { getSystemExecutor } from '../agents/system-executor.js';
import * as os from 'os';
import * as path from 'path';
import { skillStore } from './skill-store.js';
import { proposalStore } from './proposal-store.js';

const STUDIO_EVENTS_JSONL = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const fileStore = new FileStore();

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

    const spStatus = autoPublish ? 'approved' : 'pending';
    const spSummary = autoPublish
      ? `Auto-published (confidence: ${confidence.toFixed(2)} >= 0.8)`
      : `Pending review (confidence: ${confidence.toFixed(2)} < 0.8)`;

    const sp = proposalStore.create({
      skillId: skill.id,
      status: spStatus,
      proposedBy: 'system',
      summary: spSummary,
    });

    // S3 Gap 3c: emit skill_created for knowledge_skill_created metric
    fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'knowledge:skill_created',
      source: 'skill-extraction',
      payload: JSON.stringify({ skillName: proposal.name, skillId: skill.id }),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

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
      // pending proposal → push notification to #system channel
      try {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        await channelMessageService.createCardMessage(
          'system',
          'knowledge_keeper',
          `Skill pending review: **${proposal.name}**\nDescription: ${proposal.description}\nCategory: ${proposal.category}\nConfidence: ${(confidence * 100).toFixed(0)}%\nSource Goal: ${proposal.sourceGoalIds.join(', ')}`,
          'skill_review_request',
          { proposalId: sp.id, skillId: skill.id },
        );
        logger.info('[SkillExtraction] Pending review notification sent', { proposalId: sp.id, name: proposal.name });
      } catch (e) {
        logger.warn('[SkillExtraction] Pending notification failed (non-blocking)', { error: String(e) });
      }
    }

    return { skillId: skill.id, proposalId: sp.id, autoPublished: autoPublish };
  }

  async reviewProposal(proposalId: string, approved: boolean): Promise<boolean> {
    const p = proposalStore.get(proposalId);
    if (!p || p.status !== 'pending') return false;

    proposalStore.update(proposalId, {
      status: approved ? 'approved' : 'rejected',
      reviewedAt: new Date().toISOString(),
    });

    if (approved) {
      const skill = skillStore.get(p.skillId);
      skillStore.update(p.skillId, { status: 'draft' });

      // Generate SKILL.md file
      try {
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const skillName = skill?.name || p.skillId;
        const metadata = skill?.metadata ? JSON.parse(skill.metadata) : {};
        const skillsDir = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
        const skillDir = path.join(skillsDir, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          logger.info('[SkillExtraction] SKILL.md already exists, skipping', { skillName, path: skillFile });
          return true;
        }
        fs.mkdirSync(skillDir, { recursive: true });

        const pattern = metadata.pattern || `Skill: ${skillName}\n\nTBD -- manual refinement needed.`;
        const frontmatter = [
          '---',
          `name: '${skillName}'`,
          'version: 1',
          `agentTypes: ['executor']`,
          `tier: 'standard'`,
          `status: 'draft'`,
          '---',
        ].join('\n');
        const content = `${frontmatter}\n\n${pattern}`;
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        logger.info('[SkillExtraction] SKILL.md generated', { skillName, path: skillDir });
      } catch (e) {
        logger.warn('[SkillExtraction] SKILL.md generation failed (non-blocking)', { error: String(e) });
      }

    }
    return true;
  }

  async getPendingProposals(companyId: string) {
    const pendingProposals = proposalStore.list(
      { status: 'pending' },
      { orderBy: { field: 'proposedAt', dir: 'desc' } },
    );

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

    const r = await getSystemExecutor().runJson<{ hasPattern: boolean; name?: string; description?: string; category?: string; pattern?: string; confidence?: number }>(prompt, { systemPrompt: 'You are a Skill extraction analyst.' });

    if (!r.hasPattern || !r.name) return null;
    return { id: '', skillId: '', companyId, name: r.name, description: r.description || '', category: r.category || 'general', pattern: r.pattern || '', sourceGoalIds: [], confidence: r.confidence || 0.5, status: 'pending', createdAt: new Date() };
  }
}

export const skillExtractionService = new SkillExtractionService();
