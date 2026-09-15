/**
 * auditor-execution — 建议执行 / 升级 / 闭环单元测试
 * applyLowRiskSuggestions / pushConfirmationCards / autoCreateResolutions /
 * escalateToTriage / generateEvalCases
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, mockHandleAlert, mockMatch, mockCreateResolution, mockGenEval } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-exec-home-')),
    mockHandleAlert: vi.fn(() => Promise.resolve()),
    mockMatch: vi.fn(() => Promise.resolve({ matched: null })),
    mockCreateResolution: vi.fn(() => Promise.resolve({ id: 'res-new' })),
    mockGenEval: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

vi.mock('../triage/triage.service.js', () => ({
  triageService: { handleAlert: mockHandleAlert },
}));

vi.mock('../../knowledge/resolution.service.js', () => ({
  resolutionService: { matchResolutions: mockMatch, createResolution: mockCreateResolution },
}));

vi.mock('../../knowledge/eval-case-generator.js', () => ({
  evalCaseGenerator: { generateFromFailures: mockGenEval },
}));

import { skillStore } from '../../skills/skill-store.js';
import {
  applyLowRiskSuggestions,
  pushConfirmationCards,
  buildAuditorNotificationLink,
  autoCreateResolutions,
  escalateToTriage,
  generateEvalCases,
} from '../auditor/auditor-execution.js';

// ── buildAuditorNotificationLink（#439）──

describe('buildAuditorNotificationLink()', () => {
  it('有卡消息 id 时 link 带 ?highlight=<mid> 直达锚点', () => {
    expect(buildAuditorNotificationLink('ch-1', 'm-1')).toBe('/channels/ch-1?highlight=m-1');
  });

  it('无卡消息 id 时降级为频道粒度链接', () => {
    expect(buildAuditorNotificationLink('ch-1', null)).toBe('/channels/ch-1');
  });
});

// ── applyLowRiskSuggestions ──

describe('applyLowRiskSuggestions()', () => {
  beforeEach(() => {
    skillStore.deleteMany({ name: { startsWith: '__exec_test_' } });
  });

  it('applies skill_weight: updates successRate in store', async () => {
    const s = skillStore.create({ companyId: 'exec-test', name: '__exec_test_low', source: 'extraction', status: 'published' });
    const applied = await applyLowRiskSuggestions([{
      type: 'skill_weight', risk: 'low', skillId: s.id, skillName: '__exec_test_low',
      detail: 'd', data: { successRate: 0.25 },
    }]);

    expect(applied.length).toBe(1);
    expect(applied[0]).toContain('__exec_test_low');
    expect(skillStore.get(s.id)?.successRate).toBe(0.25);
  });

  it('applies skill_status: draft → published', async () => {
    const s = skillStore.create({ companyId: 'exec-test', name: '__exec_test_draft', source: 'extraction', status: 'draft' });
    const applied = await applyLowRiskSuggestions([{
      type: 'skill_status', risk: 'low', skillId: s.id, skillName: '__exec_test_draft',
      detail: 'd', data: { successRate: 0.85, currentStatus: 'draft' },
    }]);

    expect(applied.length).toBe(1);
    expect(applied[0]).toContain('auto-published');
    expect(skillStore.get(s.id)?.status).toBe('published');
  });

  it('records low-risk circuit_fix without side effects', async () => {
    const applied = await applyLowRiskSuggestions([{
      type: 'circuit_fix', risk: 'low', detail: '某个低风险电路建议',
    }]);
    expect(applied.length).toBe(1);
    expect(applied[0]).toContain('电路建议已记录');
  });

  it('records skill_weight even when skill no longer exists (update returns null)', async () => {
    const applied = await applyLowRiskSuggestions([{
      type: 'skill_weight', risk: 'low', skillId: 'nonexistent-id', skillName: 'ghost',
      detail: 'd', data: { successRate: 0.1 },
    }]);
    expect(applied.length).toBe(1);
  });
});

// ── pushConfirmationCards ──

const { mockSubmitProposal } = vi.hoisted(() => ({
  mockSubmitProposal: vi.fn(async () => ({ proposalId: 'p-439', posted: true })),
}));

// 只替换提案提交入口；findAuditorCardMessageId 等保留真实实现（走 mock fileStore）
vi.mock('../auditor/review-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auditor/review-adapter.js')>();
  return { ...actual, submitAuditorSuggestionProposal: mockSubmitProposal };
});

describe('pushConfirmationCards()', () => {
  it('returns immediately for empty suggestions without touching fileStore', async () => {
    const listChannels = vi.fn();
    await pushConfirmationCards({ listChannels } as any, []);
    expect(listChannels).not.toHaveBeenCalled();
  });

  // #439：通知 link 携带消息粒度（?highlight=<卡消息 id>），点通知可直达卡消息
  describe('通知 link 消息粒度（#439）', () => {
    // studio-dir 走 'node:os' 视图，'os' 命名空间 mock 管不到它——用 STUDIO_HOME 隔离数据根
    const studioHome = path.join(tmpHome, '.studio');
    const usersDir = path.join(studioHome, 'data', 'users');
    let savedStudioHome: string | undefined;
    const mkFileStore = (messages: Array<{ id: string; meta?: string }>) => {
      const appendJsonl = vi.fn(async () => {});
      return {
        appendJsonl,
        fileStore: {
          listChannels: vi.fn(async () => [{ id: 'ch-sys', name: '#系统' }]),
          queryMessages: vi.fn(async () => messages),
          appendJsonl,
        },
      };
    };
    const notificationLinks = (appendJsonl: ReturnType<typeof vi.fn>) =>
      appendJsonl.mock.calls.map(c => (c[1] as { link?: string })?.link).filter(Boolean);

    beforeEach(() => {
      mockSubmitProposal.mockClear();
      savedStudioHome = process.env.STUDIO_HOME;
      process.env.STUDIO_HOME = studioHome;
      fs.mkdirSync(usersDir, { recursive: true });
      fs.writeFileSync(path.join(usersDir, 'u-439.json'), '{}');
    });

    afterEach(() => {
      if (savedStudioHome === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = savedStudioHome;
    });

    it('卡消息反查命中 → 通知 link 带 ?highlight=<mid>', async () => {
      const { fileStore, appendJsonl } = mkFileStore([
        { id: 'm-card', meta: JSON.stringify({ cardData: { proposalId: 'p-439' } }) },
      ]);
      await pushConfirmationCards(fileStore as any, [
        { type: 'param_tuning', risk: 'high', detail: 'd' },
      ] as any);

      expect(notificationLinks(appendJsonl)).toContain('/channels/ch-sys?highlight=m-card');
    });

    it('卡消息反查不到 → 降级为频道粒度链接，通知照发', async () => {
      const { fileStore, appendJsonl } = mkFileStore([]);
      await pushConfirmationCards(fileStore as any, [
        { type: 'param_tuning', risk: 'high', detail: 'd' },
      ] as any);

      expect(notificationLinks(appendJsonl)).toContain('/channels/ch-sys');
    });
  });
});

// ── escalateToTriage ──

describe('escalateToTriage()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('escalates agent-type failure trend when failureRate > 30% and total >= 3', async () => {
    const stats = new Map([['executor', { total: 4, failed: 2 }]]);
    await escalateToTriage(stats, 100, 4, 0);

    expect(mockHandleAlert).toHaveBeenCalledTimes(1);
    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_type_failure_trend',
      severity: 'critical',
      message: expect.stringContaining('executor'),
      details: expect.objectContaining({ failingAgentType: 'executor', failureRate: 50, total: 4, failed: 2 }),
    }));
  });

  it('does NOT escalate agent-type when below thresholds', async () => {
    const stats = new Map([['executor', { total: 4, failed: 1 }]]); // 25%
    await escalateToTriage(stats, 100, 4, 0);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  it('escalates workunit_health_degraded when successRate < 50% and total >= 5', async () => {
    await escalateToTriage(new Map(), 40, 10, 6);
    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'workunit_health_degraded',
      details: { overallSuccessRate: 40, total: 10, failed: 6 },
    }));
  });

  it('does NOT escalate workunit_health when total < 5', async () => {
    await escalateToTriage(new Map(), 0, 4, 4);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });
});

// ── autoCreateResolutions ──

describe('autoCreateResolutions()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatch.mockResolvedValue({ matched: null });
  });

  it('creates L4 pending resolution for permission errors', async () => {
    await autoCreateResolutions([{
      status: 'closed', error: 'EACCES permission denied opening /etc/foo', agentType: 'executor',
    }]);

    expect(mockCreateResolution).toHaveBeenCalledTimes(1);
    expect(mockCreateResolution).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'permission',
      layer: 'L4_env_config',
      fix: '（待人工补充解法）',
      tags: ['permission', 'auto-detected'],
    }));
  });

  it('creates L3 pending resolution for docker errors', async () => {
    await autoCreateResolutions([{
      status: 'closed', error: 'docker container failed to start properly', agentType: 'executor',
    }]);
    expect(mockCreateResolution).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'docker',
      layer: 'L3_tool_behavior',
    }));
  });

  it('skips code-class errors (test_failure)', async () => {
    await autoCreateResolutions([{ status: 'closed', error: 'jest test failed badly again', agentType: 'executor' }]);
    expect(mockMatch).not.toHaveBeenCalled();
    expect(mockCreateResolution).not.toHaveBeenCalled();
  });

  it('skips when a matching resolution already exists', async () => {
    mockMatch.mockResolvedValue({ matched: { id: 'res-1' } });
    await autoCreateResolutions([{
      status: 'closed', error: 'EACCES permission denied opening /etc/foo', agentType: 'executor',
    }]);
    expect(mockCreateResolution).not.toHaveBeenCalled();
  });

  it('skips too-short patterns and non-closed execs', async () => {
    await autoCreateResolutions([
      { status: 'closed', error: 'git fail', agentType: 'executor' }, // pattern < 10 chars
      { status: 'open', error: 'EACCES permission denied opening /etc/foo', agentType: 'executor' },
    ]);
    expect(mockCreateResolution).not.toHaveBeenCalled();
  });
});

// ── generateEvalCases ──

describe('generateEvalCases()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when there are no failures', async () => {
    await generateEvalCases([{ status: 'open', error: null, agentType: 'executor', input: null }]);
    expect(mockGenEval).not.toHaveBeenCalled();
  });

  it('maps failures to eval cases with extracted task description', async () => {
    await generateEvalCases([{
      status: 'closed', error: 'boom', agentType: 'executor',
      input: JSON.stringify({ taskDescription: 'fix the bug' }), id: 'e1', goalId: 'g1',
    }]);

    expect(mockGenEval).toHaveBeenCalledTimes(1);
    expect(mockGenEval).toHaveBeenCalledWith([expect.objectContaining({
      workUnitId: 'g1',
      executionId: 'e1',
      error: 'boom',
      taskDescription: 'fix the bug',
      changedFiles: [],
      agentType: 'executor',
    })]);
  });

  it('falls back to prompt substring (200 chars) and unknown ids', async () => {
    await generateEvalCases([{
      status: 'closed', error: 'boom', agentType: null,
      input: JSON.stringify({ prompt: 'x'.repeat(300) }),
    }]);

    const arg = mockGenEval.mock.calls[0][0][0];
    expect(arg.workUnitId).toBe('unknown');
    expect(arg.executionId).toBe('unknown');
    expect(arg.taskDescription.length).toBe(200);
    expect(arg.agentType).toBeUndefined();
  });

  it('taskDescription is undefined for unparseable input', async () => {
    await generateEvalCases([{ status: 'closed', error: 'boom', agentType: 'executor', input: '{invalid json' }]);
    expect(mockGenEval.mock.calls[0][0][0].taskDescription).toBeUndefined();
  });
});
