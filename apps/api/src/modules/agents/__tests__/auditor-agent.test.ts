/**
 * Auditor Agent B3-005 tests — generateSuggestions + applyLowRisk + channel actions
 *
 * Migrated from Prisma Skill to file-based SkillStore (D-005).
 * Still uses Prisma for Company, Channel, ChannelMessage, StudioEvent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { skillStore } from '../../skills/skill-store.js';

let testCompanyId: string;
let testChannelId: string;
let testSkillLowSR: string;   // successRate < 0.3
let testSkillHighSR: string;  // successRate >= 0.8 + draft
let testSkillNormal: string;  // normal, shouldn't trigger

describe('AuditorAgent B3-005', () => {
  beforeAll(async () => {
    // Find or create test company
    let company = await prisma.company.findFirst();
    if (!company) {
      company = await prisma.company.create({ data: { name: 'Test Corp' } });
    }
    testCompanyId = company.id;

    // Find or create system channel
    let channel = await prisma.channel.findUnique({ where: { name: '#系统' } });
    if (!channel) {
      channel = await prisma.channel.create({ data: { name: '#系统', type: 'system' } });
    }

    // Create session:summary events so activeSessionCount >= 5 (required for skill audit)
    const eventCount = await prisma.studioEvent.count({
      where: { type: 'session:summary', timestamp: { gte: new Date(Date.now() - 28 * 24 * 3600_000) } },
    });
    for (let i = eventCount; i < 5; i++) {
      await prisma.studioEvent.create({
        data: { type: 'session:summary', source: 'test', payload: '{}', timestamp: new Date() },
      });
    }
    testChannelId = channel.id;
  });

  afterAll(async () => {
    // Cleanup test skills from SkillStore
    skillStore.deleteMany({ companyId: testCompanyId });
    // Cleanup test messages
    await prisma.channelMessage.deleteMany({ where: { channelId: testChannelId, agentName: 'Auditor', content: { contains: '审计建议 — 待人工确认' } } });
  });

  beforeEach(async () => {
    // Clean up test skills from previous runs
    skillStore.deleteMany({ name: { startsWith: '__test_' } });

    // Clean test messages
    await prisma.channelMessage.deleteMany({
      where: { channelId: testChannelId, content: { contains: '审计建议 — 待人工确认' } },
    });

    // Create test skills
    const s1 = skillStore.create({
      companyId: testCompanyId,
      name: '__test_low_success_rate',
      source: 'extraction',
      status: 'published',
    });
    skillStore.update(s1.id, { usageCount: 10, successRate: 0.2 });
    testSkillLowSR = s1.id;

    const s2 = skillStore.create({
      companyId: testCompanyId,
      name: '__test_high_success_rate_draft',
      source: 'extraction',
      status: 'draft',
    });
    skillStore.update(s2.id, { usageCount: 8, successRate: 0.85 });
    testSkillHighSR = s2.id;

    const s3 = skillStore.create({
      companyId: testCompanyId,
      name: '__test_normal_skill',
      source: 'extraction',
      status: 'published',
    });
    skillStore.update(s3.id, { usageCount: 20, successRate: 0.6 });
    testSkillNormal = s3.id;
  });

  // ── generateSuggestions ──

  describe('generateSuggestions()', () => {
    it('detects skill_weight: successRate < 0.3 + usageCount >= 5', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const errorByAgentType = new Map<string, Map<string, number>>();

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const skillWeight = suggestions.filter((s: any) => s.type === 'skill_weight');
      expect(skillWeight.length).toBeGreaterThanOrEqual(1);
      const lowSR = skillWeight.find((s: any) => s.skillId === testSkillLowSR);
      expect(lowSR).toBeDefined();
      expect(lowSR.risk).toBe('low');
      expect(lowSR.skillName).toBe('__test_low_success_rate');
    });

    it('detects skill_status: successRate >= 0.8 + status = draft', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const errorByAgentType = new Map<string, Map<string, number>>();

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const skillStatus = suggestions.filter((s: any) => s.type === 'skill_status');
      const highSR = skillStatus.find((s: any) => s.skillId === testSkillHighSR);
      expect(highSR).toBeDefined();
      expect(highSR.risk).toBe('low');
      expect(highSR.data.currentStatus).toBe('draft');
    });

    it('does NOT trigger skill_weight for normal successRate skills', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const errorByAgentType = new Map<string, Map<string, number>>();

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const normalTriggered = suggestions.filter(
        (s: any) => s.skillId === testSkillNormal
      );
      expect(normalTriggered.length).toBe(0);
    });

    it('detects param_tuning: agent-type timeout >= 3 + total >= 5', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 10, failed: 6 });

      const errorByAgentType = new Map<string, Map<string, number>>();
      const execErrors = new Map<string, number>();
      execErrors.set('timeout', 4);
      execErrors.set('other', 2);
      errorByAgentType.set('executor', execErrors);

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const paramTuning = suggestions.filter((s: any) => s.type === 'param_tuning');
      expect(paramTuning.length).toBe(1);
      expect(paramTuning[0].risk).toBe('high');
      expect(paramTuning[0].agentType).toBe('executor');
      expect(paramTuning[0].detail).toContain('sessionTimeoutMinutes');
    });

    it('does NOT trigger param_tuning when timeout < 3', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 10, failed: 6 });

      const errorByAgentType = new Map<string, Map<string, number>>();
      const execErrors = new Map<string, number>();
      execErrors.set('timeout', 2);
      execErrors.set('other', 4);
      errorByAgentType.set('executor', execErrors);

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const paramTuning = suggestions.filter((s: any) => s.type === 'param_tuning');
      expect(paramTuning.length).toBe(0);
    });

    it('detects prompt_optimization: failureRate > 0.3 + llm/model dominant (>=40%)', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('analyst', { total: 10, failed: 5 }); // 50% failure rate

      const errorByAgentType = new Map<string, Map<string, number>>();
      const analystErrors = new Map<string, number>();
      analystErrors.set('llm/model', 4);
      analystErrors.set('timeout', 1);
      errorByAgentType.set('analyst', analystErrors);

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const promptOpt = suggestions.filter((s: any) => s.type === 'prompt_optimization');
      expect(promptOpt.length).toBe(1);
      expect(promptOpt[0].risk).toBe('high');
      expect(promptOpt[0].agentType).toBe('analyst');
      expect(promptOpt[0].detail).toContain('prompt');
    });

    it('does NOT trigger prompt_optimization when llm errors < 40%', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('analyst', { total: 10, failed: 5 });

      const errorByAgentType = new Map<string, Map<string, number>>();
      const analystErrors = new Map<string, number>();
      analystErrors.set('llm/model', 1);
      analystErrors.set('timeout', 4);
      analystErrors.set('test_failure', 0);
      errorByAgentType.set('analyst', analystErrors);

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const promptOpt = suggestions.filter((s: any) => s.type === 'prompt_optimization');
      expect(promptOpt.length).toBe(0);
    });

    it('returns empty suggestions when no issues detected', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      // Only normal skills, no error data
      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 100, failed: 5 }); // 5% failure, fine

      const errorByAgentType = new Map<string, Map<string, number>>();
      const execErrors = new Map<string, number>();
      execErrors.set('type/lint', 5);
      errorByAgentType.set('executor', execErrors);

      // Temporarily remove the low-SR and high-SR-draft skills
      skillStore.deleteMany({ name: { startsWith: '__test_low_success_rate' } });
      skillStore.deleteMany({ name: { startsWith: '__test_high_success_rate_draft' } });

      try {
        const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);
        expect(suggestions.length).toBe(0);
      } finally {
        // Restore
        const s1 = skillStore.create({
          companyId: testCompanyId,
          name: '__test_low_success_rate',
          source: 'extraction',
          status: 'published',
        });
        skillStore.update(s1.id, { usageCount: 10, successRate: 0.2 });
        testSkillLowSR = s1.id;

        const s2 = skillStore.create({
          companyId: testCompanyId,
          name: '__test_high_success_rate_draft',
          source: 'extraction',
          status: 'draft',
        });
        skillStore.update(s2.id, { usageCount: 8, successRate: 0.85 });
        testSkillHighSR = s2.id;
      }
    });
  });

  // ── applyLowRiskSuggestions ──

  describe('applyLowRiskSuggestions()', () => {
    it('auto-applies skill_weight: updates successRate in store', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const suggestions = [{
        type: 'skill_weight',
        risk: 'low',
        skillId: testSkillLowSR,
        skillName: '__test_low_success_rate',
        detail: 'Test skill weight',
        data: { successRate: 0.25 },
      }];

      const applied = await (agent as any).applyLowRiskSuggestions(suggestions);
      expect(applied.length).toBe(1);
      expect(applied[0]).toContain('__test_low_success_rate');
      expect(applied[0]).toContain('successRate');

      // Verify store update
      const updated = skillStore.get(testSkillLowSR);
      expect(updated?.successRate).toBe(0.25);
    });

    it('auto-applies skill_status: draft -> published', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const suggestions = [{
        type: 'skill_status',
        risk: 'low',
        skillId: testSkillHighSR,
        skillName: '__test_high_success_rate_draft',
        detail: 'Test skill status',
        data: { successRate: 0.85, currentStatus: 'draft' },
      }];

      const applied = await (agent as any).applyLowRiskSuggestions(suggestions);
      expect(applied.length).toBe(1);
      expect(applied[0]).toContain('auto-published');

      // Verify store update
      const updated = skillStore.get(testSkillHighSR);
      expect(updated?.status).toBe('published');
    });

    it('writes both types of suggestions when mixed', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const suggestions = [
        {
          type: 'skill_weight',
          risk: 'low',
          skillId: testSkillLowSR,
          skillName: '__test_low_success_rate',
          detail: 'Weight update',
          data: { successRate: 0.15 },
        },
        {
          type: 'skill_status',
          risk: 'low',
          skillId: testSkillHighSR,
          skillName: '__test_high_success_rate_draft',
          detail: 'Publish',
          data: { successRate: 0.85, currentStatus: 'draft' },
        },
      ];

      const applied = await (agent as any).applyLowRiskSuggestions(suggestions);
      expect(applied.length).toBe(2);

      const updatedLow = skillStore.get(testSkillLowSR);
      const updatedHigh = skillStore.get(testSkillHighSR);
      expect(updatedLow?.successRate).toBe(0.15);
      expect(updatedHigh?.status).toBe('published');
    });
  });

  // ── pushConfirmationCards ──

  describe('pushConfirmationCards()', () => {
    it('creates auditor_suggestion card in system channel', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const suggestions = [{
        type: 'param_tuning',
        risk: 'high',
        agentType: 'executor',
        detail: 'executor timeout errors 3/5, suggest sessionTimeoutMinutes adjustment',
        data: { agentType: 'executor', timeoutCount: 3, totalErrors: 5, execTotal: 10 },
      }];

      await (agent as any).pushConfirmationCards(suggestions);

      // Verify card was created
      const card = await prisma.channelMessage.findFirst({
        where: {
          channelId: testChannelId,
          agentName: 'Auditor',
          content: { contains: '审计建议 — 待人工确认' },
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(card).not.toBeNull();
      // meta is auto-parsed by Prisma middleware
      const meta = typeof card!.meta === 'string' ? JSON.parse(card!.meta as string) : card!.meta;
      expect(meta.cardType).toBe('auditor_suggestion');
      expect(meta.status).toBe('ready');
      expect(meta.cardData.suggestions).toHaveLength(1);
      expect(meta.cardData.suggestions[0].type).toBe('param_tuning');
    });
  });
});
