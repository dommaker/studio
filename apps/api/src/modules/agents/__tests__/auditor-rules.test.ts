/**
 * auditor-rules — 审计规则单元测试
 * classifyError / generateSuggestions / analyzeCircuitHealth
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, eventsFile, mockLogger, mockGetStats } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rules-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-rules-home-')),
    tmpEvents,
    eventsFile,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockGetStats: vi.fn(() => ({ total: 0 })),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => {
  for (const d of [tmpHome, tmpEvents]) fs.rmSync(d, { recursive: true, force: true });
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { getStats: mockGetStats },
}));

import { skillStore } from '../../skills/skill-store.js';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import {
  classifyError,
  studioEventsJsonl,
  generateSuggestions,
  analyzeCircuitHealth,
} from '../auditor/auditor-rules.js';

/** 模拟 FileStore.readJsonl：读 JSONL 文件，缺失返回 [] */
const fileStoreStub = {
  readJsonl: async (filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
  },
  listDocs: async () => [] as string[],
} as any;

function writeSessionEvents(count: number): void {
  // D18: 历史扁平形态（timestamp 顶层）写入统一事件文件 —— 读方经 getStudioEventTime 兼容
  const eventsJsonl = Array.from({ length: count }, (_, i) => JSON.stringify({
    id: `evt-rules-${i}`,
    type: 'session:summary', source: 'test', payload: '{}', timestamp: new Date().toISOString(),
  })).join('\n');
  fs.writeFileSync(eventsFile, eventsJsonl + '\n', 'utf-8');
}

// ── classifyError ──

describe('classifyError()', () => {
  it('classifies known error categories', () => {
    expect(classifyError('Request timeout after 30s')).toBe('timeout');
    expect(classifyError('operation timed out')).toBe('timeout');
    expect(classifyError('Docker container exited')).toBe('docker');
    expect(classifyError('git worktree add failed')).toBe('git/worktree');
    expect(classifyError('prisma database locked')).toBe('database');
    expect(classifyError('sqlite busy')).toBe('database');
    expect(classifyError('tsc type error')).toBe('type/lint');
    expect(classifyError('eslint lint failed')).toBe('type/lint');
    expect(classifyError('jest test failed')).toBe('test_failure');
    expect(classifyError('listen EADDRINUSE :::3000')).toBe('port_conflict');
    expect(classifyError('EACCES permission denied')).toBe('permission');
    expect(classifyError('llm model token limit exceeded')).toBe('llm/model');
    expect(classifyError('something completely weird')).toBe('other');
  });

  it('handles non-string input gracefully', () => {
    expect(classifyError(null as any)).toBe('other');
    expect(classifyError(12345 as any)).toBe('other');
  });
});

// ── generateSuggestions ──

describe('generateSuggestions()', () => {
  let lowSrId: string;
  let highSrDraftId: string;
  let normalId: string;

  beforeAll(() => {
    writeSessionEvents(5);
  });

  beforeEach(() => {
    skillStore.deleteMany({ name: { startsWith: '__rules_test_' } });

    const s1 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_low_sr', source: 'extraction', status: 'published' });
    skillStore.update(s1.id, { usageCount: 10, successRate: 0.2 });
    lowSrId = s1.id;

    const s2 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_high_sr_draft', source: 'extraction', status: 'draft' });
    skillStore.update(s2.id, { usageCount: 8, successRate: 0.85 });
    highSrDraftId = s2.id;

    const s3 = skillStore.create({ companyId: 'rules-test', name: '__rules_test_normal', source: 'extraction', status: 'published' });
    skillStore.update(s3.id, { usageCount: 20, successRate: 0.6 });
    normalId = s3.id;
  });

  afterAll(() => {
    skillStore.deleteMany({ name: { startsWith: '__rules_test_' } });
  });

  it('detects skill_weight underperform (low) + auto-demote (high) for low-SR published skill', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    const forSkill = suggestions.filter(s => s.skillId === lowSrId);

    const underperform = forSkill.find(s => s.risk === 'low' && s.type === 'skill_weight');
    expect(underperform).toBeDefined();
    expect(underperform!.detail).toContain('建议优化 prompt');

    const demote = forSkill.find(s => s.risk === 'high' && s.data?.action === 'demote');
    expect(demote).toBeDefined();
    expect(demote!.detail).toContain('自动降级为 draft');
  });

  it('detects skill_status publish for high-SR draft skill', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    const s = suggestions.find(s => s.skillId === highSrDraftId && s.type === 'skill_status');
    expect(s).toBeDefined();
    expect(s!.risk).toBe('low');
    expect(s!.data?.currentStatus).toBe('draft');
  });

  it('does NOT trigger skill rules for normal skills', async () => {
    const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
    // normal: SR 0.6 published, usage 20/5 sessions → 400% usage rate, no rule hits
    expect(suggestions.filter(s => s.skillId === normalId).length).toBe(0);
  });

  it('detects skill_inactive when usage rate < 10% of active sessions', async () => {
    writeSessionEvents(40); // 3 usages / 40 sessions = 7.5% < 10%
    try {
      const s = skillStore.create({ companyId: 'rules-test', name: '__rules_test_inactive', source: 'extraction', status: 'published' });
      skillStore.update(s.id, { usageCount: 3, successRate: 0.6 });

      const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
      const inactive = suggestions.find(s2 => s2.skillId === s.id && s2.data?.usageRate !== undefined);
      expect(inactive).toBeDefined();
      expect(inactive!.risk).toBe('low');
      expect(inactive!.detail).toContain('建议废弃');
    } finally {
      writeSessionEvents(5);
    }
  });

  it('skips skill audit when active sessions < 5', async () => {
    fs.unlinkSync(eventsFile);
    try {
      const suggestions = await generateSuggestions(fileStoreStub, new Map(), new Map());
      expect(suggestions.filter(s => s.skillId).length).toBe(0);
    } finally {
      writeSessionEvents(5);
    }
  });

  it('detects param_tuning: timeout >= 3 + totalErrors >= 5', async () => {
    const agentTypeStats = new Map([['executor', { total: 10, failed: 6 }]]);
    const errorByAgentType = new Map([['executor', new Map([['timeout', 4], ['other', 2]])]]);

    const suggestions = await generateSuggestions(fileStoreStub, agentTypeStats, errorByAgentType);
    const pt = suggestions.filter(s => s.type === 'param_tuning');
    expect(pt.length).toBe(1);
    expect(pt[0].risk).toBe('high');
    expect(pt[0].detail).toContain('timeoutMs');
  });

  // #593：param_tuning 文案里出现的旋钮名必须落在真生效的配置面里——
  // 生效面 = runner-lightweight spawn 选项（packages/studio-agent services/runner-lightweight.ts
  // 的 timeoutMs / silenceWarnMs / silenceKillMs）；ExecutorConfig 的两个 *TimeoutMinutes 只写不读。
  it('param_tuning 文案只引用真生效的超时旋钮（防回归）', async () => {
    const EFFECTIVE_TIMEOUT_KNOBS = new Set(['timeoutMs', 'silenceWarnMs', 'silenceKillMs']);
    const agentTypeStats = new Map([['executor', { total: 10, failed: 6 }]]);
    const errorByAgentType = new Map([['executor', new Map([['timeout', 4], ['other', 2]])]]);

    const suggestions = await generateSuggestions(fileStoreStub, agentTypeStats, errorByAgentType);
    const pt = suggestions.filter(s => s.type === 'param_tuning');
    expect(pt.length).toBe(1);

    const knobNames = pt[0].detail.match(/\b[a-zA-Z]+(?:Ms|Minutes)\b/g) ?? [];
    expect(knobNames.length).toBeGreaterThan(0);
    for (const knob of knobNames) {
      expect(EFFECTIVE_TIMEOUT_KNOBS.has(knob)).toBe(true);
    }
  });

  it('detects prompt_optimization: failureRate > 0.3 + llm/model dominant', async () => {
    const agentTypeStats = new Map([['analyst', { total: 10, failed: 5 }]]);
    const errorByAgentType = new Map([['analyst', new Map([['llm/model', 4], ['timeout', 1]])]]);

    const suggestions = await generateSuggestions(fileStoreStub, agentTypeStats, errorByAgentType);
    const po = suggestions.filter(s => s.type === 'prompt_optimization');
    expect(po.length).toBe(1);
    expect(po[0].agentType).toBe('analyst');
  });
});

// ── analyzeCircuitHealth ──

describe('analyzeCircuitHealth()', () => {
  const prevRepoDir = process.env.REPO_DIR;

  beforeAll(() => {
    // Point REPO_DIR at empty tmp → Circuit 5 (CONTEXT.md scan) skipped deterministically
    process.env.REPO_DIR = tmpHome;
  });

  afterAll(() => {
    if (prevRepoDir === undefined) delete process.env.REPO_DIR;
    else process.env.REPO_DIR = prevRepoDir;
  });

  it('flags cold circuit when knowledge bus is empty', async () => {
    mockGetStats.mockReturnValue({ total: 0 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('circuit_fix');
    expect(result[0].risk).toBe('high');
    expect(result[0].detail).toContain('知识总线为空');
  });

  it('flags low accumulation when total < 10', async () => {
    mockGetStats.mockReturnValue({ total: 5, pattern: 3, failure: 2 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    const lowTotal = result.find(s => s.detail.includes('仅 5 条'));
    expect(lowTotal).toBeDefined();
    expect(lowTotal!.risk).toBe('high');
  });

  it('flags knowledge island when only one knowledge type exists', async () => {
    mockGetStats.mockReturnValue({ total: 20, pattern: 20 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    const island = result.find(s => s.detail.includes('知识孤岛'));
    expect(island).toBeDefined();
    expect(island!.risk).toBe('high');
  });

  it('returns no circuit_fix when bus is healthy', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.filter(s => s.risk === 'high').length).toBe(0);
  });
});

// ── analyzeCircuitHealth Circuit 5：散置 CONTEXT.md 覆盖 + 工单号密度（#299）──

describe('analyzeCircuitHealth() Circuit 5 散置 CONTEXT.md', () => {
  const prevRepoDir = process.env.REPO_DIR;
  let tmpRepo: string;

  function setupRepo(modules: string[], withContext: string[], bodies?: Record<string, string>): void {
    tmpRepo = fs.mkdtempSync(path.join(tmpHome, 'c5-repo-'));
    for (const m of modules) {
      const dir = path.join(tmpRepo, 'apps/api/src/modules', m);
      fs.mkdirSync(dir, { recursive: true });
      if (withContext.includes(m)) {
        fs.writeFileSync(
          path.join(dir, 'CONTEXT.md'),
          bodies?.[m] ?? `# apps/api/src/modules/${m}\n\n### 职责\n\n正文。\n`,
        );
      }
    }
    process.env.REPO_DIR = tmpRepo;
  }

  afterEach(() => {
    if (prevRepoDir === undefined) delete process.env.REPO_DIR;
    else process.env.REPO_DIR = prevRepoDir;
  });

  it('模块目录缺 CONTEXT.md → 报 low 风险 circuit_fix', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    setupRepo(['alpha', 'beta'], ['alpha']);
    const result = await analyzeCircuitHealth(fileStoreStub);
    const c5 = result.find(s => s.detail.includes('缺 CONTEXT.md'));
    expect(c5).toBeDefined();
    expect(c5!.risk).toBe('low');
    expect(c5!.detail).toContain('beta');
    expect(c5!.detail).not.toContain('alpha');
  });

  it('CONTEXT.md 齐全 → 不报缺失', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    setupRepo(['alpha'], ['alpha']);
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.find(s => s.detail.includes('缺 CONTEXT.md'))).toBeUndefined();
  });

  it('工单号密度 >0.3/行 → 报密度告警', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    // 5 行正文 3 个票号 = 0.6 > 0.3
    setupRepo(['alpha'], ['alpha'], {
      alpha: '# alpha\n\n### 注意事项\n\n- #101 改了 x\n- #102 又改了 y\n- #103 再改 z\n',
    });
    const result = await analyzeCircuitHealth(fileStoreStub);
    const dense = result.find(s => s.detail.includes('密度超线'));
    expect(dense).toBeDefined();
    expect(dense!.risk).toBe('low');
    expect(dense!.detail).toContain('alpha');
  });

  it('工单号密度 ≤0.3/行 → 不报密度告警', async () => {
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    // 10 行正文 1 个票号 = 0.1
    const body = ['# alpha', '', '### 职责', '', '正文一句。', '', '### 注意事项', '', '- 共十条注意事项逐条列明第一二三五六七八九十条 #101', ''].join('\n');
    setupRepo(['alpha'], ['alpha'], { alpha: body });
    const result = await analyzeCircuitHealth(fileStoreStub);
    expect(result.find(s => s.detail.includes('密度超线'))).toBeUndefined();
  });
});

// ── studioEventsJsonl ──

describe('studioEventsJsonl()', () => {
  it('resolves 统一事件文件（D18，STUDIO_EVENTS_FILE 可覆盖）', () => {
    expect(studioEventsJsonl()).toBe(eventsFile);
  });
});

// ── #523（#515 决议 P0-3）：okr_proposal 建单收口 WorkUnitService.create ──
// 原 commitSnapshot 直写不发 eventBus 事件，对唤醒体系完全隐形（第二个建单口）；
// 改走 create 后建单发 workunit.created（带 claimable），AgentLoop 真唤醒链路可见。

describe('#523: okr_proposal 建单走 WorkUnitService.create', () => {
  const prevRepoDir = process.env.REPO_DIR;
  let realStore: FileStore;
  let storeDir: string;

  beforeAll(() => {
    // Point REPO_DIR at empty tmp → Circuit 5 (CONTEXT.md scan) skipped deterministically
    process.env.REPO_DIR = tmpHome;
  });

  afterAll(() => {
    if (prevRepoDir === undefined) delete process.env.REPO_DIR;
    else process.env.REPO_DIR = prevRepoDir;
  });

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(tmpHome, 'okr-wu-'));
    realStore = new FileStore(storeDir);
    // 知识总线健康 → 不早退，走到 Circuit 7 OKR 检查
    mockGetStats.mockReturnValue({ total: 50, pattern: 20, failure: 15, trend: 15 });
    // Circuit 7 喂数：1 个 active OKR，KR 达成率 50% < 60% 且趋势未改善 → 触发建单
    vi.spyOn(realStore, 'listDocs').mockResolvedValue(['okr-1']);
    vi.spyOn(realStore, 'readDoc').mockResolvedValue({
      meta: {
        id: 'okr-1', status: 'active', title: '增长',
        keyResults: [{ id: 'kr-1', title: 'DAU', metricType: 'count', target: 100, unit: '' }],
      },
      body: '',
    });
    vi.spyOn(realStore, 'readJsonl').mockResolvedValue([
      { okrId: 'okr-1', krId: 'kr-1', value: 50, status: 'ok', timestamp: new Date().toISOString() },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('低达成 KR 建 okr_proposal 单：落库 + 发 workunit.created（claimable=true）', async () => {
    interface CreatedPayload { workunit: { id: string; type: string; status: string; claimable: boolean; scope: string; metadata: string } }
    const events: CreatedPayload[] = [];
    const handler = (p: CreatedPayload) => events.push(p);
    eventBus.subscribe('workunit.created', handler);
    try {
      const suggestions = await analyzeCircuitHealth(realStore);

      // 原有 suggestions.push 逻辑不动
      expect(suggestions.some(s => s.detail.includes('建议触发深度根因分析'))).toBe(true);

      // 建单走 WorkUnitService.create → 发 workunit.created 且带 claimable
      // （commitSnapshot 直写不发事件，claimable 只有 publishCreated 会算）
      expect(events.length).toBe(1);
      const wu = events[0].workunit;
      expect(wu.type).toBe('okr_proposal');
      expect(wu.status).toBe('unassigned');
      expect(wu.claimable).toBe(true);
      expect(wu.scope).toContain('[OKR优化] DAU');
      const meta = JSON.parse(wu.metadata);
      expect(meta.okrId).toBe('okr-1');
      expect(meta.krId).toBe('kr-1');
      expect(meta.attainment).toBe(0.5);

      // 落库可经 FileStore 读回（create 不支持指定 id → 用 service 生成的 id）
      const stored = await realStore.getIndex({ id: wu.id });
      expect(stored.length).toBe(1);
      expect(stored[0].type).toBe('okr_proposal');
    } finally {
      eventBus.unsubscribe('workunit.created', handler);
    }
  });
});
