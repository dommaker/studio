/**
 * KnowledgeSkillEvolver — AC-8b: skillCandidate → Skill abstraction
 *
 * Evolves high-quality KnowledgeEntries (skillCandidate) into Skills
 * via LLM-assisted extraction.
 *
 * Flow:
 *   skillCandidate entry + executionResults
 *     → LLM extracts SkillDefinition
 *     → SkillProposal created in DB
 *     → KnowledgeEntry.skillId linked
 *
 * @see docs/specs/AS-024-knowledge-search-bridge.md (Phase 5)
 */

import type { KnowledgeEntry, KnowledgeStore, KnowledgeLifecycle } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { skillStore } from '../skills/skill-store.js';
import { proposalStore } from '../skills/proposal-store.js';

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  category: string;
  triggers: string[];
}

export interface KnowledgeSkillEvolverDeps {
  store: KnowledgeStore;
  lifecycle: KnowledgeLifecycle;
}

export class KnowledgeSkillEvolver {
  private store: KnowledgeStore;
  private lifecycle: KnowledgeLifecycle;

  constructor(deps: KnowledgeSkillEvolverDeps) {
    this.store = deps.store;
    this.lifecycle = deps.lifecycle;
  }

  /**
   * Evolve a skillCandidate KnowledgeEntry into a SkillProposal.
   * Returns null if entry is not a valid skillCandidate or LLM extraction fails.
   */
  async evolveToSkill(candidateId: string): Promise<{ skillId: string; proposalId: string } | null> {
    const entry = this.store.get(candidateId);
    if (!entry) return null;
    if (!entry.tags.includes('skillCandidate')) return null;

    const executions = entry.executionResults || [];
    if (executions.length === 0) return null;

    try {
      const skillDef = await this.extractSkillDefinition(entry, executions);
      if (!skillDef) return null;

      // Create Skill in store
      const skill = skillStore.create({
        companyId: 'system',
        name: skillDef.name.slice(0, 100),
        description: skillDef.description.slice(0, 500),
        category: skillDef.category,
        source: 'knowledge_evolved',
        status: 'draft',
        tools: JSON.stringify(skillDef.triggers),
        metadata: JSON.stringify({
          prompt: skillDef.prompt,
          sourceKnowledgeId: candidateId,
          evolvedAt: new Date().toISOString(),
          executionCount: executions.length,
        }),
      });

      // Create SkillProposal
      const proposal = proposalStore.create({
        skillId: skill.id,
        status: 'pending',
        proposedBy: 'knowledge-evolver',
        summary: `Evolved from knowledge entry ${candidateId} (${executions.length} executions)`,
      });

      // Link KnowledgeEntry → Skill
      this.store.update(candidateId, { skillId: skill.id });

      // Emit event
      prisma.studioEvent.create({
        data: {
          type: 'knowledge:skill_evolved',
          source: 'knowledge-evolver',
          payload: JSON.stringify({
            knowledgeId: candidateId,
            skillId: skill.id,
            proposalId: proposal.id,
            skillName: skillDef.name,
          }),
        },
      }).catch(() => {});

      logger.info('[KnowledgeSkillEvolver] Evolved skillCandidate to Skill', {
        candidateId,
        skillId: skill.id,
        proposalId: proposal.id,
        name: skillDef.name,
      });

      return { skillId: skill.id, proposalId: proposal.id };
    } catch (e) {
      logger.warn('[KnowledgeSkillEvolver] Evolution failed', { candidateId, error: String(e) });
      return null;
    }
  }

  /**
   * Scan all entries for unprocessed skillCandidates and evolve them.
   * Returns count of newly evolved skills.
   */
  async evolveAllCandidates(): Promise<number> {
    const entries = this.store.list({});
    let evolved = 0;

    for (const entry of entries) {
      if (!entry.tags.includes('skillCandidate')) continue;
      if (entry.skillId) continue; // Already evolved

      const result = await this.evolveToSkill(entry.id);
      if (result) evolved++;
    }

    return evolved;
  }

  // ─── Private ───

  private async extractSkillDefinition(
    entry: KnowledgeEntry,
    executions: Array<{ contributor: string; success: boolean; timestamp: string }>,
  ): Promise<SkillDefinition | null> {
    const successRate = executions.filter(e => e.success).length / executions.length;
    const contributors = [...new Set(executions.map(e => e.contributor))];

    const prompt = `分析以下知识条目和执行记录，提炼一个可复用的 Skill。

## 知识条目
标题: ${entry.title}
类型: ${entry.type}
成熟度: ${entry.maturity}
内容:
${entry.content.slice(0, 2000)}

## 执行记录
总次数: ${executions.length}
成功率: ${(successRate * 100).toFixed(0)}%
贡献者: ${contributors.join(', ')}
最近执行: ${executions.slice(-3).map(e => `${e.timestamp} (${e.success ? '成功' : '失败'})`).join(', ')}

## 要求
输出 JSON:
{
  "name": "skill名称 (简洁英文, kebab-case)",
  "description": "一句话描述",
  "prompt": "可注入 Agent 的完整 prompt (中文, 包含具体步骤和注意事项)",
  "category": "code_gen|testing|review|refactor|config|docs|debug|deploy",
  "triggers": ["触发条件1", "触发条件2"]
}`;

    const systemPrompt = '你是 Skill 提取分析师。从知识条目和执行记录中提炼可复用的 Skill。只输出 JSON，不要其他内容。';

    try {
      const result = await modelGateway.promptJson<SkillDefinition>(prompt, systemPrompt);
      if (!result.name || !result.prompt) return null;
      return result;
    } catch (e) {
      logger.warn('[KnowledgeSkillEvolver] LLM extraction failed', { error: String(e) });
      return null;
    }
  }
}

import { sharedStore, sharedLifecycle } from './knowledge-bus.service.js';

export const knowledgeSkillEvolver = new KnowledgeSkillEvolver({
  store: sharedStore,
  lifecycle: sharedLifecycle,
});
