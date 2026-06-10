/**
 * Skill Extraction Service — 面向新架构 GoalExecution
 *
 * 从 GoalExecution 成功记录中提取可复用模式（Pattern）。
 * 这里的 "Skill" 不是旧 workflow 的 Execution 模式，
 * 而是"同类型任务在不同项目中反复成功"的可复用 prompt 模板。
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway, recordDecision } from '@dommaker/studio-shared';

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

/** Map workflowType to SKILL.md trigger subdirectory */
export function workflowTypeToTriggerDir(workflowType: string): string {
  const map: Record<string, string> = {
    ci_fix: 'goal-start',
    test_triage: 'goal-start',
    config_change: 'goal-start',
    architecture: 'goal-start',
    refactor: 'goal-start',
    pr_review: 'review',
    release_prep: 'integration',
    changelog: 'integration',
    doc_update: 'always',
    knowledge_curation: 'always',
    skill_creation: 'always',
  };
  return map[workflowType] || 'always';
}

export class SkillExtractionService {
  /** 从 GoalExecution 提取可复用模式 */
  async extractFromGoalExecution(goalExecutionId: string): Promise<ExtractedSkillProposal | null> {
    const ge = await prisma.goalExecution.findUnique({
      where: { id: goalExecutionId },
      select: { id: true, goalId: true, status: true, input: true, output: true },
    });
    if (!ge || ge.status !== 'succeeded') return null;

    const goal = await prisma.goal.findUnique({ where: { id: ge.goalId }, select: { companyId: true } });
    if (!goal?.companyId) return null;

    const acGroup = (ge.input as any)?.acGroup;
    const acs = acGroup?.acs?.join(' ') || '';
    const files = acGroup?.files?.join(' ') || '';

    // 找同公司其他成功 GoalExecution（两步查询：goal→executions）
    const companyGoalIds = (await prisma.goal.findMany({ where: { companyId: goal.companyId, status: 'succeeded' }, select: { id: true }, take: 20 })).map(g => g.id);
    const similar = await prisma.goalExecution.findMany({
      where: { goalId: { in: companyGoalIds }, status: 'succeeded', id: { not: goalExecutionId } },
      take: 10, orderBy: { completedAt: 'desc' },
      select: { id: true, input: true, output: true },
    });
    if (similar.length < 1) return null;

    try {
      return await this.analyzeWithLLM(
        { acs, files, output: ge.output },
        similar.map(s => ({ acs: (s.input as any)?.acGroup?.acs?.join(' ') || '', output: s.output })),
        goal.companyId,
      );
    } catch (error) {
      logger.error('[SkillExtraction] Failed', { error: String(error) });
      return null;
    }
  }

  /** 跨项目扫描 Pattern */
  async scanForPatterns(companyId: string): Promise<ExtractedSkillProposal[]> {
    const goals = await prisma.goal.findMany({
      where: { companyId, status: 'succeeded' },
      select: { id: true, GoalExecution: { where: { status: 'succeeded' }, select: { id: true, input: true, output: true }, take: 3 } },
      take: 30, orderBy: { completedAt: 'desc' },
    });

    const proposals: ExtractedSkillProposal[] = [];
    const grouped = new Map<string, typeof goals>();
    for (const g of goals) {
      if (g.GoalExecution.length < 2) continue;
      const key = (g.GoalExecution[0].input as any)?.acGroup?.acs?.[0]?.slice(0, 30) || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(g);
    }

    for (const [, group] of grouped) {
      if (group.length < 2) continue;
      const main = group[0].GoalExecution[0];
      try {
        const p = await this.analyzeWithLLM(
          { acs: (main.input as any)?.acGroup?.acs?.join('; ') || '', output: main.output },
          group.slice(1).map(g => ({ acs: (g.GoalExecution[0].input as any)?.acGroup?.acs?.join('; ') || '', output: g.GoalExecution[0].output })),
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

    const skill = await prisma.skill.create({
      data: {
        companyId: proposal.companyId, name: proposal.name, description: proposal.description,
        category: proposal.category, source: 'auto_extracted',
        status: autoPublish ? 'published' : 'draft',  // 🆕 BP-003: ≥ 0.8 直接 published
        metadata: JSON.stringify({ pattern: proposal.pattern, sourceGoalIds: proposal.sourceGoalIds, confidence }),
      },
    });

    const spStatus = autoPublish ? 'approved' : 'pending';
    const spSummary = autoPublish
      ? `Auto-published (confidence: ${confidence.toFixed(2)} ≥ 0.8)`
      : `Pending review (confidence: ${confidence.toFixed(2)} < 0.8)`;

    const sp = await prisma.skillProposal.create({
      data: { skillId: skill.id, status: spStatus, proposedBy: 'system', summary: spSummary },
    });

    // S3 Gap 3c: emit skill_created for knowledge_skill_created metric
    prisma.studioEvent.create({
      data: {
        type: 'knowledge:skill_created',
        source: 'skill-extraction',
        payload: JSON.stringify({ skillName: proposal.name, skillId: skill.id }),
      },
    }).catch(() => {});

    if (autoPublish) {
      logger.info('[SkillExtraction] Auto-published skill', {
        name: proposal.name,
        confidence,
        skillId: skill.id,
      });

      // 🆕 Discord 通知: Skill 自动发布
      try {
        const { discordNotifier } = await import('../../utils/discord-notifier.js');
        discordNotifier.sendText(
          '🟢 Skill 自动发布',
          `**${proposal.name}** (${proposal.category})\n置信度: ${(confidence * 100).toFixed(0)}%\n来源目标: ${proposal.sourceGoalIds.join(', ')}`
        ).catch(() => {});
      } catch (e) {
        logger.warn('[SkillExtraction] Discord notification failed (non-blocking)', { error: String(e) });
      }

      // 🆕 审计: Skill 自动发布
      try {
        recordDecision({
          eventType: 'skill.auto_published',
          entityType: 'skill',
          entityId: skill.id,
          companyId: proposal.companyId,
          summary: `Skill 自动发布: ${proposal.name}（confidence: ${confidence.toFixed(2)}）`,
          details: { name: proposal.name, category: proposal.category, confidence, sourceGoalIds: proposal.sourceGoalIds },
          actorRole: 'knowledge_keeper',
        });
      } catch (e) {
        logger.warn('[SkillExtraction] Audit recording failed (non-blocking)', { error: String(e) });
      }
    } else {
      // ⑦: pending proposal → 推 #系统 channel 审批通知
      try {
        const { channelMessageService } = await import('../channels/channel-message.service.js');
        await channelMessageService.createCardMessage(
          'system',
          'knowledge_keeper',
          `技能待审批: **${proposal.name}**\n描述: ${proposal.description}\n分类: ${proposal.category}\n置信度: ${(confidence * 100).toFixed(0)}%\n来源 Goal: ${proposal.sourceGoalIds.join(', ')}`,
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
    const p = await prisma.skillProposal.findUnique({ where: { id: proposalId }, include: { skill: true } });
    if (!p || p.status !== 'pending') return false;
    await prisma.skillProposal.update({ where: { id: proposalId }, data: { status: approved ? 'approved' : 'rejected', reviewedAt: new Date() } });
    if (approved) {
      await prisma.skill.update({ where: { id: p.skillId }, data: { status: 'draft' } });

      // Generate SKILL.md file
      try {
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const skillName = p.skill?.name || p.skillId;
        const metadata = p.skill?.metadata ? JSON.parse(p.skill.metadata) : {};
        const trigger = workflowTypeToTriggerDir(metadata.workflowType || '');
        const skillsDir = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
        const skillDir = path.join(skillsDir, trigger, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          logger.info('[SkillExtraction] SKILL.md already exists, skipping', { skillName, path: skillFile });
          return true;
        }
        fs.mkdirSync(skillDir, { recursive: true });

        const pattern = metadata.pattern || `Skill: ${skillName}\n\nTBD — manual refinement needed.`;
        const frontmatter = [
          '---',
          `name: '${skillName}'`,
          'version: 1',
          `agentTypes: ['executor']`,
          `tier: 'standard'`,
          `status: 'draft'`,
          `trigger: ${trigger}`,
          '---',
        ].join('\n');
        const content = `${frontmatter}\n\n${pattern}`;
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        logger.info('[SkillExtraction] SKILL.md generated', { skillName, trigger, path: skillDir });
      } catch (e) {
        logger.warn('[SkillExtraction] SKILL.md generation failed (non-blocking)', { error: String(e) });
      }

      // ⑧: knowledge→role 回流 — 已批准 skill 自动添加为角色能力
      try {
        const { roleConfigService } = await import('../roles/role-config.service.js');
        const roles = await prisma.role.findMany({ where: { name: { in: ['executor', 'developer'] } } });
        for (const role of roles) {
          await (roleConfigService as unknown as { addCapability: (roleId: string, cap: string, source: string) => Promise<void> }).addCapability(role.id, `skill:${p.skill?.name || p.skillId}`, 'learned').catch(() => {});
        }
        logger.info('[SkillExtraction] Capabilities synced to roles', { skillName: p.skill?.name, roleCount: roles.length });
      } catch (e) {
        logger.warn('[SkillExtraction] Role sync failed (non-blocking)', { error: String(e) });
      }
    }
    return true;
  }

  async getPendingProposals(companyId: string) {
    return prisma.skillProposal.findMany({ where: { status: 'pending', skill: { companyId } }, include: { skill: true }, orderBy: { proposedAt: 'desc' } });
  }

  // ─── Private ───

  private async analyzeWithLLM(
    main: { acs: string; files?: string; output: any },
    similar: Array<{ acs: string; output: any }>,
    companyId: string,
  ): Promise<ExtractedSkillProposal | null> {
    const prompt = `分析以下 Goal 执行记录，判断是否有可复用的模式。

目标执行 AC: ${main.acs}${main.files ? '\n文件: ' + main.files : ''}
相似成功执行: ${similar.map((s, i) => `\n${i + 1}. ${s.acs}`).join('')}

输出 JSON: {"hasPattern": bool, "name": "模式名", "description": "描述", "category": "code_gen|testing|review|refactor|config|docs", "pattern": "可注入 Agent 的 prompt 模板", "confidence": 0.8}`;

    const r = await modelGateway.promptJson<{ hasPattern: boolean; name?: string; description?: string; category?: string; pattern?: string; confidence?: number }>(prompt, '你是 Skill 提取分析师。');

    if (!r.hasPattern || !r.name) return null;
    return { id: '', skillId: '', companyId, name: r.name, description: r.description || '', category: r.category || 'general', pattern: r.pattern || '', sourceGoalIds: [], confidence: r.confidence || 0.5, status: 'pending', createdAt: new Date() };
  }
}

export const skillExtractionService = new SkillExtractionService();
