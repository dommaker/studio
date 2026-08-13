/**
 * #91 — composeStepPrompt 函数级测试接缝：分段软定额 + 池内余量共享 + trim 埋点
 *
 * - 七段软定额：map 800（#111 T5）/ skills 600 / persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800
 * - 池内余量共享：前段未用定额流入共享池，后段有效预算 = 定额 + 池（总量封顶 ~4.3K）
 * - 任一段截断落 prompt:section_trimmed 事件（段名/原始 token 数/截断后 token 数/定额），
 *   经 metricsFileStore fire-and-forget 写 studio-events.jsonl
 * - role preset 的 skills/tools/constraints 进入「## 你的角色」段
 * - base prompt 不再引用不存在的 AGENTS.generated.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import prompt-composer
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-skills-'));
process.env.SKILLS_DIR = testSkillsDir;

const { mockInjectContext, mockAppendJsonl, mockProjectGet } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockProjectGet: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: { injectContext: mockInjectContext },
}));

vi.mock('../loop/agent-loop-events', () => ({
  metricsFileStore: { appendJsonl: mockAppendJsonl },
}));

vi.mock('../../pmo/project.service.js', () => ({
  projectService: { get: mockProjectGet },
}));

import { FileStore, estimateTokens } from '@dommaker/studio-shared';
import type { AgentProfileData } from '@dommaker/studio-shared';

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载
const { composeStepPrompt, SECTION_QUOTAS } = await import('../loop/prompt-composer');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

const SKILL_HEADER = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';

function writeSkill(name: string, description: string) {
  fs.mkdirSync(path.join(testSkillsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(testSkillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\nagentTypes: [feature]\ntriggers: [登录]\nstatus: published\n---\n\n## 正文\n`,
    'utf-8',
  );
  invalidateManifestCache();
}

function clearSkills() {
  for (const entry of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, entry), { recursive: true, force: true });
  }
  invalidateManifestCache();
}

const makeRole = (overrides: Record<string, unknown> = {}) => ({
  id: 'role-1',
  name: 'test-agent',
  description: null,
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
}) as unknown as AgentProfileData;

const makeWu = (overrides: Record<string, unknown> = {}) => ({
  id: 'wu-1',
  type: 'feature',
  scope: '实现登录功能',
  channelId: null,
  ...overrides,
}) as any;

describe('#91: composeStepPrompt 分段软定额 + 池内余量共享 + trim 埋点', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  const sectionTrimmedEvents = () =>
    mockAppendJsonl.mock.calls
      .map(c => c[1])
      .filter((e: any) => e.type === 'prompt:section_trimmed')
      .map((e: any) => JSON.parse(e.payload));

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-fs-'));
    fileStore = new FileStore(testDir);
  });

  it('七段软定额表：map 800 / skills 600 / persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800', () => {
    expect(SECTION_QUOTAS).toEqual({
      map: 800,
      skills: 600,
      persona: 300,
      roster: 400,
      memory: 300,
      knowledge: 1000,
      handoff: 800,
    });
  });

  it('池内余量共享：前段未用定额流入后段（全空时 knowledge 有效预算 = 3400）', async () => {
    await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // map 800 + skills 600 + persona 300 + roster 400 + memory 300 全未用 → 余量入池
      maxTokens: 1000 + 800 + 600 + 300 + 400 + 300,
    });
  });

  it('skills 段占定额后余量入池：knowledge 预算 = 1000 + (1400 - skillTokens) + 300 + 400 + 300', async () => {
    writeSkill('feature-dev', '功能开发流程');
    const skillBlock = `### feature-dev\n功能开发流程｜触发：登录\n全文：${path.join(os.homedir(), '.studio', 'skills', 'feature-dev', 'SKILL.md')}`;
    const skillTokens = estimateTokens(SKILL_HEADER.length) + estimateTokens(skillBlock.length + 2);

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(skillMatched).toEqual(['feature-dev']);
    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // skills 有效预算 = 600 + map 余量 800 = 1400
      maxTokens: 1000 + (1400 - skillTokens) + 300 + 400 + 300,
    });
    // 未截断 → 无 section_trimmed 事件（skill_used 事件不经 mock 的 metricsFileStore 之外的断言）
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('skills 段超有效预算（定额 600 + map 余量 800）截断并落 prompt:section_trimmed（段名/原始/截断后/定额齐全）', async () => {
    writeSkill('big-skill', '述'.repeat(6000)); // 单块 ~1500+ token，超 1400 有效预算

    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    expect(events[0].quota).toBe(600);
    expect(events[0].trimmedTokens).toBe(1400);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    // skills 有效预算用尽（余量 0）→ knowledge 预算 = 1000 + 300 + 400 + 300
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 2000,
    });
  });

  it('persona 段超有效预算（定额 300 + map 800 + skills 600 余量）截断并落事件，定额字段记名义定额 300', async () => {
    const persona = '角'.repeat(8000); // ~2000 token > 有效预算 1700

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({ persona })),
    );

    expect(knowledgeContext).toContain('## 你的角色');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('persona');
    expect(events[0].quota).toBe(300);
    expect(events[0].trimmedTokens).toBe(1700);
    expect(events[0].originalTokens).toBeGreaterThan(1700);
    // persona 用尽有效预算 → 余量 0；knowledge 预算 = 1000 + 400 + 300
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 1700,
    });
  });

  it('roster 段超有效预算截断并落事件', async () => {
    const now = new Date().toISOString();
    const memberIds = Array.from({ length: 20 }, (_, i) => `p-${i}`);
    await fileStore.createChannel({
      id: 'ch-1', name: '#test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(memberIds),
      createdAt: now, updatedAt: now,
    } as any);
    for (const id of memberIds) {
      await fileStore.createProfile({
        id, name: id, description: '员'.repeat(500),
        channels: '[]', status: 'active', provider: 'claude',
        createdAt: now, updatedAt: now,
      } as any);
    }

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu({ channelId: 'ch-1' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain('## 频道成员与委派');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('roster');
    expect(events[0].quota).toBe(400);
    // 有效预算 = 400 + map 800 + skills 600 + persona 300 = 2100
    expect(events[0].trimmedTokens).toBe(2100);
    expect(events[0].originalTokens).toBeGreaterThan(2100);
  });

  it('knowledge 段内部截断（injectContext usage）→ 落 knowledge 的 section_trimmed 事件', async () => {
    mockInjectContext.mockResolvedValue({
      prompt: '## 系统约束\n- test rule',
      injectedIds: ['rule-1'],
      usage: { originalTokens: 1500, keptTokens: 1000 },
    });

    await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('knowledge');
    expect(events[0].quota).toBe(1000);
    expect(events[0].originalTokens).toBe(1500);
    expect(events[0].trimmedTokens).toBe(1000);
  });

  it('role preset 的 skills/tools/constraints 进入「## 你的角色」段', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({
        persona: '你是开发者。',
        skills: ['tdd-implement', 'task-planner'],
        tools: ['read', 'write'],
        constraints: { can_delegate: false, max_concurrent_tasks: 2 },
      })),
    );

    expect(knowledgeContext).toContain('## 你的角色\n\n你是开发者。');
    expect(knowledgeContext).toContain('技能：tdd-implement、task-planner');
    expect(knowledgeContext).toContain('工具：read、write');
    expect(knowledgeContext).toContain('约束：can_delegate=false；max_concurrent_tasks=2');
  });

  it('skills/tools/constraints 缺省时「## 你的角色」段维持 persona 原文', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({ persona: '只是自述。' })),
    );

    expect(knowledgeContext).toContain('## 你的角色\n\n只是自述。');
    expect(knowledgeContext).not.toContain('技能：');
    expect(knowledgeContext).not.toContain('约束：');
  });

  it('base prompt 不再引用 AGENTS.generated.md', async () => {
    const { prompt } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(prompt).not.toContain('AGENTS.generated.md');
  });
});

describe('#111 T5: PMO 地图段完整渲染（destination + 近 N 条决策 + 开放雾清单 + 分段预算截断）', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  const sectionTrimmedEvents = () =>
    mockAppendJsonl.mock.calls
      .map(c => c[1])
      .filter((e: any) => e.type === 'prompt:section_trimmed')
      .map((e: any) => JSON.parse(e.payload));

  const composeWithMap = (map: unknown) => {
    mockProjectGet.mockResolvedValue({ id: 'proj-1', map });
    return composeStepPrompt(
      { wu: makeWu(), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole()),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectGet.mockResolvedValue(null);
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-pmo-map-'));
    fileStore = new FileStore(testDir);
  });

  it('有地图 → destination 一行 + 决策新→旧 + 开放雾（open/in-discussion）清单，resolved 雾不列', async () => {
    const { prompt } = await composeWithMap({
      destination: '把结算链路迁到新引擎',
      decisions: [
        { wuId: 'wu-a', summary: '旧决策：先单机部署', resolvedAt: '2026-08-01T10:00:00Z' },
        { wuId: 'wu-b', summary: '新决策：存储用 PostgreSQL', resolvedAt: '2026-08-11T10:00:00Z' },
      ],
      fog: [
        { id: 'F1', question: '回滚方案？', wuId: null, status: 'open' },
        { id: 'F2', question: '已解决的问题', wuId: 'wu-a', status: 'resolved' },
        { id: 'F3', question: '灰度策略？', wuId: null, status: 'in-discussion' },
      ],
    });

    expect(mockProjectGet).toHaveBeenCalledWith('proj-1');
    expect(prompt).toContain('## PMO 地图');
    expect(prompt).toContain('目标：把结算链路迁到新引擎');
    // decisions 新→旧（数组尾 = 最新）
    const newIdx = prompt.indexOf('新决策：存储用 PostgreSQL');
    const oldIdx = prompt.indexOf('旧决策：先单机部署');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
    // 开放雾 = open + in-discussion；resolved 不列
    expect(prompt).toContain('开放雾（2 条）');
    expect(prompt).toContain('- [open] 回滚方案？');
    expect(prompt).toContain('- [in-discussion] 灰度策略？');
    expect(prompt).not.toContain('已解决的问题');
    // 未超预算 → 无截断埋点
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('决策超过 N=10 条 → 只渲染最近 10 条（新的在前），N 封顶本身不算截断（无埋点）', async () => {
    const decisions = Array.from({ length: 12 }, (_, i) => ({
      wuId: `wu-${i}`,
      summary: `决策A${String(i).padStart(2, '0')}`,
      resolvedAt: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));

    const { prompt } = await composeWithMap({
      destination: '目标 X',
      decisions,
      fog: [],
    });

    expect(prompt).toContain('决策A11'); // 最新
    expect(prompt).toContain('决策A02'); // 第 10 新
    expect(prompt).not.toContain('决策A01');
    expect(prompt).not.toContain('决策A00'); // 最旧被 N 封顶
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('无开放雾 → 渲染「开放雾：无」；无决策 → 不渲染决策块', async () => {
    const { prompt } = await composeWithMap({
      destination: '目标 X',
      decisions: [],
      fog: [{ id: 'F1', question: 'q', wuId: 'wu-1', status: 'resolved' }],
    });

    expect(prompt).toContain('目标：目标 X');
    expect(prompt).toContain('开放雾：无');
    expect(prompt).not.toContain('已落地决策');
  });

  it('决策 summary 紧凑截断：单条超 160 字符截断加省略号', async () => {
    const { prompt } = await composeWithMap({
      destination: '目标 X',
      decisions: [{ wuId: 'wu-1', summary: '结'.repeat(300), resolvedAt: '2026-08-11T10:00:00Z' }],
      fog: [],
    });

    expect(prompt).toContain(`${'结'.repeat(160)}…`);
    expect(prompt).not.toContain('结'.repeat(161));
  });

  it('超预算 → fog 全保留、decisions 从旧到新截（保最新），落 prompt:section_trimmed(section=map)', async () => {
    // 30 条开放雾 × ~60 字（不可裁底 ~570 tok）+ 10 条顶格 160 字决策（~430 tok）→ 原始 ~1000+ tok > 800 定额
    const fog = Array.from({ length: 30 }, (_, i) => ({
      id: `F${i}`,
      question: `雾问题-${String(i).padStart(2, '0')}：${'详'.repeat(50)}`,
      wuId: null,
      status: i % 2 === 0 ? 'open' : 'in-discussion',
    }));
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      wuId: `wu-${i}`,
      summary: `决策结论-${i}：${'结'.repeat(150)}`,
      resolvedAt: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));

    const { prompt } = await composeWithMap({ destination: '目标 X', decisions, fog });

    // fog 全保留（30 条一条不少）
    for (let i = 0; i < 30; i++) {
      expect(prompt).toContain(`雾问题-${String(i).padStart(2, '0')}：`);
    }
    // decisions 保最新、从旧截：最新在，最旧不在
    expect(prompt).toContain('决策结论-9');
    expect(prompt).not.toContain('决策结论-0');
    // 截断埋点：section=map / quota=800 / 截后 ≤ 800 < 原始
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('map');
    expect(events[0].quota).toBe(800);
    expect(events[0].trimmedTokens).toBeLessThanOrEqual(800);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
  });

  it('无地图（非探路型 PMO）→ 不渲染该段（行为同现状）', async () => {
    mockProjectGet.mockResolvedValue({ id: 'proj-1', map: null });

    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## PMO 地图');
  });

  it('WU 无 pmoId → 不查 PMO、不渲染该段', async () => {
    const { prompt } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockProjectGet).not.toHaveBeenCalled();
    expect(prompt).not.toContain('## PMO 地图');
  });

  it('PMO 读取失败 → 按无地图处理，不阻断执行（non-blocking）', async () => {
    mockProjectGet.mockRejectedValue(new Error('io error'));

    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## PMO 地图');
  });
});

describe('#95: handoff 前序进展段', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  const meta = (overrides: Record<string, unknown> = {}) => ({
    stepCount: 2,
    progressLog: [
      { step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' },
      { step: 2, action: 'progress', summary: '完成接口层', at: '2026-08-12T10:05:00Z' },
    ],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '', injectedIds: [] });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-handoff-'));
    fileStore = new FileStore(testDir);
  });

  it('续用不命中（isNewSession）+ stepCount>0 → prompt 含前序进展段（progressLog 逐条渲染）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: meta() as any, isNewSession: true },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 前序进展');
    expect(prompt).toContain('第 1 步 [progress]：完成数据层');
    expect(prompt).toContain('第 2 步 [progress]：完成接口层');
  });

  it('续用命中（非新会话）→ 不注入前序进展段', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: meta() as any, isNewSession: false },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## 前序进展');
  });

  it('stepCount=0（首步）→ 不注入前序进展段', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: meta({ stepCount: 0 }) as any, isNewSession: true },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## 前序进展');
  });

  it('errorType 存在 → 附「上一步失败」行（失败步不落 log 但注入失败行）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: meta({ errorType: 'execution_failed' }) as any, isNewSession: true },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 前序进展');
    expect(prompt).toContain('上一步执行失败');
    expect(prompt).toContain('execution_failed');
  });

  it('挂载位：base 之后、hint 之前', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: meta({ commitGuardHint: '有未提交改动' }) as any, isNewSession: true },
      deps(makeRole()),
    );

    const baseIdx = prompt.indexOf('## 当前工作');
    const handoffIdx = prompt.indexOf('## 前序进展');
    const hintIdx = prompt.indexOf('## 提交提醒');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(handoffIdx).toBeGreaterThan(baseIdx);
    expect(hintIdx).toBeGreaterThan(handoffIdx);
  });

  it('progressLog 空且无 errorType → 不注入（空段）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu(), metadata: { stepCount: 2 } as any, isNewSession: true },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## 前序进展');
  });
});
