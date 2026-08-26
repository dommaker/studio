/**
 * Auditor Agent B3-005 tests — generateSuggestions + applyLowRisk + channel actions
 *
 * Migrated from Prisma Skill to file-based SkillStore (D-005).
 * Still uses Prisma for Company, Channel, ChannelMessage, StudioEvent.
 *
 * 隔离（2026-07-28 flake 修复）：os.homedir 直接补丁到 tmpHome。vi.mock('os') /
 * vi.mock('node:os') 在本 vitest 4.1.10 环境对内建模块不生效（实测 FileStore 仍落
 * /root/.studio/data）——必须经 require 在模块加载前补丁 module.exports（vi.hoisted
 * 先于 import 求值，skill-store 的模块级 DATA_DIR 也被正确重定向）。
 * 此前本文件用真实 home 的 FileStore，与其他并行测试文件互相把对方的 #系统 频道当
 * 「stale」删掉（pushConfirmationCards 的卡片发到别的频道 id）→ 并行必现失败，
 * 且污染线上数据目录。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { tmpHome, origHomedir } = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const orig = os.homedir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-service-home-'));
  os.homedir = () => tmp;
  return { tmpHome: tmp, origHomedir: orig };
});

import { FileStore } from '@dommaker/studio-shared';
import { skillStore } from '../../skills/skill-store.js';

let testCompanyId: string;
let testChannelId: string;
let testSkillLowSR: string;   // successRate < 0.3
let testSkillHighSR: string;  // successRate >= 0.8 + draft
let testSkillNormal: string;  // normal, shouldn't trigger
let testEventsDir: string;
let prevStudioEventsFile: string | undefined;

describe('AuditorService B3-005', () => {
  const fileStore = new FileStore();

  beforeAll(async () => {
    // Use generated test company ID (Prisma removed, Spec 4 AC-6a)
    testCompanyId = `test-company-${Date.now()}`;

    // Create system channel in FileStore (for channelMessageService)
    const channelId = `system-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fileStore.createChannel({
      id: channelId,
      name: '#系统',
      type: 'system',
        defaultWorkspaceId: null,
        defaultPath: null,
        discordChannelId: null,
        discordWebhookUrl: null,
        members: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    // Clean up stale #系统 channels from previous test runs
    const staleSystemChannels = await fileStore.listChannels({ name: '#系统' });
    for (const stale of staleSystemChannels) {
      if (stale.id !== channelId) {
        await fileStore.deleteChannel(stale.id).catch(() => {});
      }
    }

    // Create session:summary events in a tmp STUDIO_EVENTS_FILE — D18 后代码
    // 经 utils/studio-events 的 resolveStudioEventsFile() 懒解析统一事件文件。
    // Keeps fixtures out of the real home dir.
    prevStudioEventsFile = process.env.STUDIO_EVENTS_FILE;
    testEventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-events-'));
    process.env.STUDIO_EVENTS_FILE = path.join(testEventsDir, 'studio-events.jsonl');
    const eventsJsonl = Array.from({ length: 5 }, (_, i) => JSON.stringify({
      id: `evt-summary-${Date.now()}-${i}`,
      type: 'session:summary', source: 'test', payload: '{}', timestamp: new Date().toISOString(),
    })).join('\n');
    fs.appendFileSync(process.env.STUDIO_EVENTS_FILE, eventsJsonl + '\n');
    testChannelId = channelId;
  });

  afterAll(async () => {
    // Cleanup test skills from SkillStore
    skillStore.deleteMany({ companyId: testCompanyId });
    // Restore env + drop tmp events dir + 还原 homedir 补丁（同 worker 后续文件不受影响）
    const os = require('node:os');
    os.homedir = origHomedir;
    if (prevStudioEventsFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
    else process.env.STUDIO_EVENTS_FILE = prevStudioEventsFile;
    if (testEventsDir) fs.rmSync(testEventsDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up test skills from previous runs
    skillStore.deleteMany({ name: { startsWith: '__test_' } });

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const errorByAgentType = new Map<string, Map<string, number>>();

      const suggestions = await (agent as any).generateSuggestions(agentTypeStats, errorByAgentType);

      const normalTriggered = suggestions.filter(
        (s: any) => s.skillId === testSkillNormal
      );
      expect(normalTriggered.length).toBe(0);
    });

    it('detects param_tuning: agent-type timeout >= 3 + total >= 5', async () => {
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

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
      const { AuditorService } = await import('../auditor/auditor.service.js');
      const agent = new AuditorService();

      const suggestions = [{
        type: 'param_tuning',
        risk: 'high',
        agentType: 'executor',
        detail: 'executor timeout errors 3/5, suggest sessionTimeoutMinutes adjustment',
        data: { agentType: 'executor', timeoutCount: 3, totalErrors: 5, execTotal: 10 },
      }];

      await (agent as any).pushConfirmationCards(suggestions);

      // Verify card was created in FileStore
      const allMsgs = await fileStore.queryAllMessages({ agentNames: ['Auditor'] });
      const card = allMsgs.find(m =>
        m.channelId === testChannelId &&
        m.content.includes('审计建议 — 待人工确认'),
      );

      expect(card).toBeDefined();
      const meta = typeof card!.meta === 'string' ? JSON.parse(card!.meta) : (card!.meta ?? {});
      expect(meta.cardType).toBe('auditor_suggestion');
      expect(meta.status).toBe('ready');
      // #356：发卡归 review-proposal 正本——cardData 增 proposalId（通用端点审批接线用）
      expect(meta.cardData.proposalId).toBeTruthy();
      expect(meta.cardData.suggestions).toHaveLength(1);
      expect(meta.cardData.suggestions[0].type).toBe('param_tuning');
    });
  });
});
