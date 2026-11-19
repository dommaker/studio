/**
 * bootstrap/bridges 测试（P2-a）：14 项事件订阅按原 index.ts 顺序初始化；
 * 单项失败只 log，不阻断后续订阅。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('../../modules/agent-loop/index.js', () => ({
  getReviewDispatcher: () => ({ subscribeToEvents: () => calls.push('review-dispatcher') }),
}));
vi.mock('../../modules/knowledge/index.js', () => ({
  getKnowledgeExtractionEffects: () => ({ recoverPending: async () => { calls.push('knowledge-extraction-recovery'); } }),
  getKnowledgeOutcomeEffects: () => ({ recoverPending: async () => { calls.push('knowledge-outcome-recovery'); } }),
}));
vi.mock('../../modules/events/workunit-events-bridge.js', () => ({
  initWorkunitEventsBridge: () => calls.push('workunit-events-bridge'),
}));
// #687/#683：桥归 ops——mock 整个 barrel，避免加载 monitor.service 等重依赖
vi.mock('../../modules/ops/index.js', () => ({
  initLockEventsBridge: () => calls.push('lock-events-bridge'),
}));
vi.mock('../../modules/pmo/analysis-handoff.js', () => ({
  initAnalysisHandoff: () => calls.push('analysis-handoff'),
}));
vi.mock('../../modules/workunit/in-review-inbox.js', () => ({
  initInReviewInbox: () => calls.push('in-review-inbox'),
}));
vi.mock('../../modules/pmo/decision-resolution.js', () => ({
  initDecisionResolution: () => calls.push('decision-resolution'),
}));
vi.mock('../../modules/pmo/map-opening.js', () => ({
  initMapOpening: () => calls.push('map-opening'),
}));
vi.mock('../../modules/pmo/spec-materialization.js', () => ({
  initSpecMaterialization: () => calls.push('spec-materialization'),
}));
vi.mock('../../modules/role-memory/index.js', () => ({
  initWuCompletionExtraction: () => calls.push('completion-extraction'),
  roleMemoryMaintenance: { recoverPending: async () => { calls.push('role-memory-maintenance-recovery'); } },
  initRoleMemoryUsageScan: () => calls.push('role-memory-usage-scan'),
}));
vi.mock('../../modules/skills/index.js', () => ({
  recoverSkillPublications: async () => { calls.push('skill-publication-recovery'); },
  initSkillUsageScan: () => calls.push('skill-usage-scan'),
  initSessionPatternSuggest: () => calls.push('session-pattern-suggest'),
}));
vi.mock('../../modules/skills/skill-usage-scan.js', () => ({
  initSkillUsageScan: () => calls.push('skill-usage-scan'),
}));
vi.mock('../../modules/skills/session-pattern-suggest.js', () => ({
  initSessionPatternSuggest: () => calls.push('session-pattern-suggest'),
}));
vi.mock('../../modules/distill/distill-runtime.js', () => ({
  initDistillLoop: () => calls.push('distill-loop'),
}));

import { initEventSubscriptions } from '../bridges.js';

beforeEach(() => {
  calls.length = 0;
});

describe('initEventSubscriptions', () => {
  it('按原 index.ts 顺序初始化全部 17 项订阅', async () => {
    await initEventSubscriptions();
    expect(calls).toEqual([
      'knowledge-extraction-recovery',
      'knowledge-outcome-recovery',
      'review-dispatcher',
      'workunit-events-bridge',
      'lock-events-bridge',
      'analysis-handoff',
      'in-review-inbox',
      'decision-resolution',
      'map-opening',
      'spec-materialization',
      'completion-extraction',
      'role-memory-maintenance-recovery',
      'role-memory-usage-scan',
      'skill-publication-recovery',
      'skill-usage-scan',
      'session-pattern-suggest',
      'distill-loop',
    ]);
  });
});
