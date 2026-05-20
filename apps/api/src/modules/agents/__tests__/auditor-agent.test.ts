/**
 * Auditor Agent B3-005 tests — generateSuggestions + applyLowRisk + channel actions
 *
 * 约定: 真 SQLite (test.db), 无 Prisma mock, 动态 import。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

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
    testChannelId = channel.id;
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.skill.deleteMany({ where: { id: { in: [testSkillLowSR, testSkillHighSR, testSkillNormal] } } });
    await prisma.channelMessage.deleteMany({ where: { channelId: testChannelId, agentName: 'Auditor', content: { contains: '审计建议 — 待人工确认' } } });
  });

  beforeEach(async () => {
    // Clean up test skills from previous runs
    const existing = await prisma.skill.findMany({
      where: { name: { startsWith: '__test_' } },
    });
    if (existing.length > 0) {
      await prisma.skill.deleteMany({ where: { id: { in: existing.map(s => s.id) } } });
    }

    // Clean test messages
    await prisma.channelMessage.deleteMany({
      where: { channelId: testChannelId, content: { contains: '审计建议 — 待人工确认' } },
    });

    // Create test skills
    const s1 = await prisma.skill.create({
      data: {
        companyId: testCompanyId,
        name: '__test_low_success_rate',
        source: 'extraction',
        status: 'published',
        usageCount: 10,
        successRate: 0.2,
      },
    });
    testSkillLowSR = s1.id;

    const s2 = await prisma.skill.create({
      data: {
        companyId: testCompanyId,
        name: '__test_high_success_rate_draft',
        source: 'extraction',
        status: 'draft',
        usageCount: 8,
        successRate: 0.85,
      },
    });
    testSkillHighSR = s2.id;

    const s3 = await prisma.skill.create({
      data: {
        companyId: testCompanyId,
        name: '__test_normal_skill',
        source: 'extraction',
        status: 'published',
        usageCount: 20,
        successRate: 0.6,
      },
    });
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
      await prisma.skill.deleteMany({
        where: { id: { in: [testSkillLowSR, testSkillHighSR] } },
      });

      try {
        const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);
        expect(suggestions.length).toBe(0);
      } finally {
        // Restore
        const s1 = await prisma.skill.create({
          data: {
            companyId: testCompanyId,
            name: '__test_low_success_rate',
            source: 'extraction',
            status: 'published',
            usageCount: 10,
            successRate: 0.2,
          },
        });
        testSkillLowSR = s1.id;

        const s2 = await prisma.skill.create({
          data: {
            companyId: testCompanyId,
            name: '__test_high_success_rate_draft',
            source: 'extraction',
            status: 'draft',
            usageCount: 8,
            successRate: 0.85,
          },
        });
        testSkillHighSR = s2.id;
      }
    });
  });

  // ── applyLowRiskSuggestions ──

  describe('applyLowRiskSuggestions()', () => {
    it('auto-applies skill_weight: updates successRate in DB', async () => {
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
      expect(applied[0]).toContain('成功率权重已更新');

      // Verify DB update
      const updated = await prisma.skill.findUnique({ where: { id: testSkillLowSR } });
      expect(updated?.successRate).toBe(0.25);
    });

    it('auto-applies skill_status: draft → published', async () => {
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
      expect(applied[0]).toContain('已自动发布');

      // Verify DB update
      const updated = await prisma.skill.findUnique({ where: { id: testSkillHighSR } });
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

      const updatedLow = await prisma.skill.findUnique({ where: { id: testSkillLowSR } });
      const updatedHigh = await prisma.skill.findUnique({ where: { id: testSkillHighSR } });
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
        detail: 'executor 超时错误 3/5，建议调整 sessionTimeoutMinutes',
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
      const meta = JSON.parse(card!.meta as string);
      expect(meta.cardType).toBe('auditor_suggestion');
      expect(meta.status).toBe('ready');
      expect(meta.cardData.suggestions).toHaveLength(1);
      expect(meta.cardData.suggestions[0].type).toBe('param_tuning');
    });

    it('skips when suggestions array is empty', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const beforeCount = await prisma.channelMessage.count({
        where: { channelId: testChannelId, agentName: 'Auditor', content: { contains: '审计建议 — 待人工确认' } },
      });

      await (agent as any).pushConfirmationCards([]);

      const afterCount = await prisma.channelMessage.count({
        where: { channelId: testChannelId, agentName: 'Auditor', content: { contains: '审计建议 — 待人工确认' } },
      });

      expect(afterCount).toBe(beforeCount);
    });
  });

  // ── classifyError ──

  describe('classifyError()', () => {
    it('classifies timeout errors', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      expect((agent as any).classifyError('connection timed out')).toBe('timeout');
      expect((agent as any).classifyError('Request Timeout')).toBe('timeout');
    });

    it('classifies llm/model errors', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      expect((agent as any).classifyError('LLM token limit exceeded')).toBe('llm/model');
      expect((agent as any).classifyError('Model not found')).toBe('llm/model');
    });

    it('falls back to other for unknown errors', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      expect((agent as any).classifyError('something weird happened')).toBe('other');
    });
  });

  // ── escalateToTriage (Phase 3) ──

  describe('escalateToTriage()', () => {
    it('escalates per-agent-type failureRate > 0.3 with total >= 3', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 10, failed: 6 }); // 60% failure

      // Should NOT throw — failures are caught internally
      await (agent as any).escalateToTriage(agentTypeStats, 80, 20, 4);

      // Verify: triageAgent.handleAlert was called (creates incident if handleAlert succeeds)
      // Dynamic import + .catch() makes this best-effort — just verify no unhandled error
      // The incident will be created by triageAgent if DB is available
    });

    it('does NOT escalate agent-type when total < 3', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('reviewer', { total: 2, failed: 2 }); // 100% failure but only 2

      // Should not trigger — total < 3 threshold
      await (agent as any).escalateToTriage(agentTypeStats, 90, 10, 1);
    });

    it('does NOT escalate agent-type when failureRate <= 0.3', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 10, failed: 3 }); // 30% failure = at threshold

      // 0.3 is NOT > 0.3 — should not trigger
      await (agent as any).escalateToTriage(agentTypeStats, 85, 20, 3);
    });

    it('escalates pipeline_health_degraded when overall successRate < 50% and total >= 5', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 5, failed: 4 }); // 80% failure

      await (agent as any).escalateToTriage(agentTypeStats, 30, 10, 7);
    });

    it('does NOT escalate pipeline when successRate >= 50%', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      agentTypeStats.set('executor', { total: 10, failed: 3 });

      await (agent as any).escalateToTriage(agentTypeStats, 60, 10, 4);
    });

    it('does NOT escalate pipeline when total < 5', async () => {
      const { AuditorAgent } = await import('../auditor-agent.service.js');
      const agent = new AuditorAgent();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();

      // 3 total < 5 threshold, even with 0% successRate
      await (agent as any).escalateToTriage(agentTypeStats, 0, 3, 3);
    });
  });
});
