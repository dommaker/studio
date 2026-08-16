/**
 * #91 — composeStepPrompt 函数级测试接缝：分段软定额 + 池内余量共享 + trim 埋点
 *
 * - 八段软定额：persona 300 / roster 400 / skills 600 / map 800（#111 T5）/ memory 300 / knowledge 1000 / contract 200（#119）/ handoff 800
 * - 池内余量共享：前段未用定额流入共享池，后段有效预算 = 定额 + 池（总量封顶 ~4.5K）
 * - 任一段截断落 prompt:section_trimmed 事件（段名/原始 token 数/截断后 token 数/定额），
 *   经 metricsFileStore fire-and-forget 写 studio-events.jsonl
 * - role preset 的 skills/tools/constraints 进入「## 你的角色」段
 * - base prompt 不再引用不存在的 AGENTS.generated.md
 * - #119 段序：稳定前缀 persona → roster → skills → map → memory → knowledge；尾组 base → contract → handoff → hint
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import prompt-composer
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-skills-'));
process.env.SKILLS_DIR = testSkillsDir;

const { mockInjectContext, mockAppendJsonl, mockProjectGet, mockReadIndex } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockProjectGet: vi.fn().mockResolvedValue(null),
  mockReadIndex: vi.fn().mockResolvedValue(''),
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

vi.mock('../../role-memory/role-memory.js', () => ({
  roleMemoryStore: { readIndex: mockReadIndex },
}));

import { FileStore } from '@dommaker/studio-shared';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { TokenEstimator } from '@dommaker/harness';

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载
const { composeStepPrompt, SECTION_QUOTAS, CONTRACT_TEMPLATES } = await import('../loop/prompt-composer');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

const SKILL_HEADER = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
const SKILL_MANIFEST_POINTER = `完整 skill 清单见 skills MANIFEST.md（${path.join(os.homedir(), '.studio', 'skills', 'MANIFEST.md')}）`;

function writeSkill(name: string, description: string) {
  fs.mkdirSync(path.join(testSkillsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(testSkillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\nagentTypes: [feature]\ntriggers: [登录]\nstatus: published\n---\n\n## 正文\n`,
    'utf-8',
  );
  invalidateManifestCache();
}

/** #92 测试：按需控制 agentTypes/description/triggers（无 agentTypes 时测 scope 文本匹配/rest 热度被硬预裁剪） */
function writeSkillMeta(name: string, meta: { description?: string; agentTypes?: string[]; triggers?: string[] }) {
  const lines = [`name: ${name}`];
  if (meta.description != null) lines.push(`description: "${meta.description}"`);
  if (meta.agentTypes) lines.push(`agentTypes: [${meta.agentTypes.join(',')}]`);
  if (meta.triggers) lines.push(`triggers: [${meta.triggers.join(',')}]`);
  lines.push('status: published');
  fs.mkdirSync(path.join(testSkillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(testSkillsDir, name, 'SKILL.md'), `---\n${lines.join('\n')}\n---\n\n## 正文\n`, 'utf-8');
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

  it('八段软定额表：persona 300 / roster 400 / skills 600 / map 800 / memory 300 / knowledge 1000 / contract 200 / handoff 800', () => {
    expect(SECTION_QUOTAS).toEqual({
      persona: 300,
      roster: 400,
      skills: 600,
      map: 800,
      memory: 300,
      knowledge: 1000,
      contract: 200,
      handoff: 800,
    });
  });

  it('池内余量共享：前段未用定额流入后段（全空时 knowledge 有效预算 = 3400）', async () => {
    await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // persona 300 + roster 400 + skills 600 + map 800 + memory 300 全未用 → 余量入池
      maxTokens: 1000 + 300 + 400 + 600 + 800 + 300,
    });
  });

  it('skills 段占定额后余量入池：knowledge 预算 = 1000 + (1300 - skillTokens) + 800 + 300', async () => {
    writeSkill('feature-dev', '功能开发流程');
    const skillBlock = `### feature-dev\n功能开发流程｜触发：登录\n全文：${path.join(os.homedir(), '.studio', 'skills', 'feature-dev', 'SKILL.md')}`;
    const skillTokens = TokenEstimator.estimateText(SKILL_HEADER) + TokenEstimator.estimateText(skillBlock + '\n\n')
      + TokenEstimator.estimateText(SKILL_MANIFEST_POINTER + '\n\n');

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(skillMatched).toEqual(['feature-dev']);
    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // skills 有效预算 = 600 + persona 300 + roster 400 余量 = 1300
      maxTokens: 1000 + (1300 - skillTokens) + 800 + 300,
    });
    // 未截断 → 无 section_trimmed 事件（skill_used 事件不经 mock 的 metricsFileStore 之外的断言）
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('skills 段超有效预算（定额 600 + persona 300 + roster 400 余量）截断并落 prompt:section_trimmed（段名/原始/截断后/定额齐全）', async () => {
    writeSkill('big-skill', '述'.repeat(6000)); // 单块 ~4000+ token（含中文 ≈1.5 字符/token），超 1300 有效预算

    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    expect(events[0].quota).toBe(600);
    expect(events[0].trimmedTokens).toBe(1300);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    // skills 有效预算用尽（余量 0）→ knowledge 预算 = 1000 + 800 + 300
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 2100,
    });
  });

  it('persona 段超有效预算（定额 300，首段无余量）截断并落事件，定额字段记名义定额 300', async () => {
    const persona = '角'.repeat(8000); // ~5300+ token > 定额 300

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({ persona })),
    );

    expect(knowledgeContext).toContain('## 你的角色');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('persona');
    expect(events[0].quota).toBe(300);
    expect(events[0].trimmedTokens).toBe(300);
    expect(events[0].originalTokens).toBeGreaterThan(300);
    // persona 用尽有效预算 → 余量 0；knowledge 预算 = 1000 + 400 + 600 + 800 + 300
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 3100,
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
    // 有效预算 = 400 + persona 300 = 700
    expect(events[0].trimmedTokens).toBe(700);
    expect(events[0].originalTokens).toBeGreaterThan(700);
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
        skills: ['tdd-implement', 'to-tickets'],
        tools: ['read', 'write'],
        constraints: { can_delegate: false, max_concurrent_tasks: 2 },
      })),
    );

    expect(knowledgeContext).toContain('## 你的角色\n\n你是开发者。');
    expect(knowledgeContext).toContain('技能：tdd-implement、to-tickets');
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

describe('#92: skills 硬预裁剪 + MANIFEST 指针', () => {
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
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-precrop-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => {
    clearSkills();
  });

  it('AC1: 不匹配 wuType 的 skill 索引行不进 prompt（scope 文本匹配与 rest 热度一并被硬预裁剪）', async () => {
    writeSkillMeta('domain-skill', { agentTypes: ['feature'] });
    writeSkillMeta('scope-only', { description: '实现登录功能相关流程' });
    writeSkillMeta('rest-skill', { description: '无关技能' });

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu({ scope: '实现登录功能' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain('### domain-skill');
    expect(knowledgeContext).not.toContain('### scope-only');
    expect(knowledgeContext).not.toContain('### rest-skill');
    expect(skillMatched).toEqual(['domain-skill']);
  });

  it('AC2: +skill 显式点名的行始终注入（域匹配为空时）', async () => {
    writeSkillMeta('hinted-skill', { description: 'xyzzy 无交集' });

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu({ type: 'zzz-无交集', scope: 'xyzzy +hinted-skill' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain('### hinted-skill');
    expect(skillMatched).toEqual(['hinted-skill']);
  });

  it('AC3: 段尾 MANIFEST 指针行存在（位于最后一个索引块之后）', async () => {
    writeSkillMeta('domain-skill', { agentTypes: ['feature'] });

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain(SKILL_MANIFEST_POINTER);
    expect(knowledgeContext.indexOf(SKILL_MANIFEST_POINTER)).toBeGreaterThan(knowledgeContext.indexOf('### domain-skill'));
  });

  it('两者皆空（无 hint 无域匹配）→ 段为空、无指针（scope 文本匹配不再兜底）', async () => {
    writeSkillMeta('scope-only', { description: '实现登录功能相关流程' });

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu({ type: 'zzz-无交集', scope: '实现登录功能' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain('## 本次任务 Skills');
    expect(knowledgeContext).not.toContain('MANIFEST');
    expect(skillMatched).toEqual([]);
  });

  it('AC4: 预裁剪与定额截断叠加 —— 超预算的 scope 匹配 skill 不进段，超预算的域匹配 skill 仍受 #91 截断且指针恒在段尾', async () => {
    writeSkillMeta('scope-big', { description: `实现登录功能 ${'述'.repeat(6000)}` });
    writeSkillMeta('domain-big', { agentTypes: ['feature'], description: '述'.repeat(6000) });

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu({ scope: '实现登录功能' }), metadata: {} as any },
      deps(makeRole()),
    );

    // 预裁剪：scope-big（scope 文本匹配）不进段；domain-big（域匹配）保留
    expect(knowledgeContext).toContain('### domain-big');
    expect(knowledgeContext).not.toContain('### scope-big');
    // 预裁剪后仍受 #91 定额截断（domain-big 单块超 1300 有效预算 → 落 skills 截断埋点）
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    expect(events[0].trimmedTokens).toBe(1300);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    // 指针恒在段尾（截断也保留）
    expect(knowledgeContext).toContain(SKILL_MANIFEST_POINTER);
    expect(knowledgeContext.indexOf(SKILL_MANIFEST_POINTER)).toBeGreaterThan(knowledgeContext.indexOf('### domain-big'));
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
    const { knowledgeContext } = await composeWithMap({
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
    expect(knowledgeContext).toContain('## PMO 地图');
    expect(knowledgeContext).toContain('目标：把结算链路迁到新引擎');
    // decisions 新→旧（数组尾 = 最新）
    const newIdx = knowledgeContext.indexOf('新决策：存储用 PostgreSQL');
    const oldIdx = knowledgeContext.indexOf('旧决策：先单机部署');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
    // 开放雾 = open + in-discussion；resolved 不列
    expect(knowledgeContext).toContain('开放雾（2 条）');
    expect(knowledgeContext).toContain('- [open] 回滚方案？');
    expect(knowledgeContext).toContain('- [in-discussion] 灰度策略？');
    expect(knowledgeContext).not.toContain('已解决的问题');
    // 未超预算 → 无截断埋点
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('决策超过 N=10 条 → 只渲染最近 10 条（新的在前），N 封顶本身不算截断（无埋点）', async () => {
    const decisions = Array.from({ length: 12 }, (_, i) => ({
      wuId: `wu-${i}`,
      summary: `决策A${String(i).padStart(2, '0')}`,
      resolvedAt: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));

    const { knowledgeContext } = await composeWithMap({
      destination: '目标 X',
      decisions,
      fog: [],
    });

    expect(knowledgeContext).toContain('决策A11'); // 最新
    expect(knowledgeContext).toContain('决策A02'); // 第 10 新
    expect(knowledgeContext).not.toContain('决策A01');
    expect(knowledgeContext).not.toContain('决策A00'); // 最旧被 N 封顶
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('无开放雾 → 渲染「开放雾：无」；无决策 → 不渲染决策块', async () => {
    const { knowledgeContext } = await composeWithMap({
      destination: '目标 X',
      decisions: [],
      fog: [{ id: 'F1', question: 'q', wuId: 'wu-1', status: 'resolved' }],
    });

    expect(knowledgeContext).toContain('目标：目标 X');
    expect(knowledgeContext).toContain('开放雾：无');
    expect(knowledgeContext).not.toContain('已落地决策');
  });

  it('决策 summary 紧凑截断：单条超 160 字符截断加省略号', async () => {
    const { knowledgeContext } = await composeWithMap({
      destination: '目标 X',
      decisions: [{ wuId: 'wu-1', summary: '结'.repeat(300), resolvedAt: '2026-08-11T10:00:00Z' }],
      fog: [],
    });

    expect(knowledgeContext).toContain(`${'结'.repeat(160)}…`);
    expect(knowledgeContext).not.toContain('结'.repeat(161));
  });

  it('超预算 → fog 全保留、decisions 从旧到新截（保最新），落 prompt:section_trimmed(section=map)', async () => {
    // 80 条开放雾（≈1910 tok，TokenEstimator 中文口径）+ 10 条决策 → 原始 ~3040 tok > 2100 有效预算（persona/roster/skills 全空余量入池）；
    // 决策从旧裁到只剩最新 1 条（fog 自身未超预算 → 不触发兜底整段截）
    const fog = Array.from({ length: 80 }, (_, i) => ({
      id: `F${i}`,
      question: `雾问题-${String(i).padStart(2, '0')}：${'详'.repeat(14)}`,
      wuId: null,
      status: i % 2 === 0 ? 'open' : 'in-discussion',
    }));
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      wuId: `wu-${i}`,
      summary: `决策结论-${i}：${'结'.repeat(150)}`,
      resolvedAt: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));

    const { knowledgeContext } = await composeWithMap({ destination: '目标 X', decisions, fog });

    // fog 全保留（80 条一条不少）
    for (let i = 0; i < 80; i++) {
      expect(knowledgeContext).toContain(`雾问题-${String(i).padStart(2, '0')}：`);
    }
    // decisions 保最新、从旧截：最新在，最旧不在
    expect(knowledgeContext).toContain('决策结论-9');
    expect(knowledgeContext).not.toContain('决策结论-0');
    // 截断埋点：section=map / quota=800 / 截后 ≤ 2100（map 有效预算）< 原始
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('map');
    expect(events[0].quota).toBe(800);
    expect(events[0].trimmedTokens).toBeLessThanOrEqual(2100);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
  });

  it('无地图（非探路型 PMO）→ 不渲染该段（行为同现状）', async () => {
    mockProjectGet.mockResolvedValue({ id: 'proj-1', map: null });

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain('## PMO 地图');
  });

  it('WU 无 pmoId → 不查 PMO、不渲染该段', async () => {
    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockProjectGet).not.toHaveBeenCalled();
    expect(knowledgeContext).not.toContain('## PMO 地图');
  });

  it('PMO 读取失败 → 按无地图处理，不阻断执行（non-blocking）', async () => {
    mockProjectGet.mockRejectedValue(new Error('io error'));

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain('## PMO 地图');
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

describe('#95: waitingQuestion 回放（仅新会话）', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '', injectedIds: [] });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-wq-'));
    fileStore = new FileStore(testDir);
  });

  it('新会话 + 人类回复 → 回放问题（并入人类回复段）', async () => {
    const { prompt } = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: { pendingReplies: ['使用账号密码'], waitingQuestion: '使用 OAuth 还是账号密码？' } as any,
        isNewSession: true,
      },
      deps(makeRole()),
    );

    expect(prompt).toContain('你此前提出的问题');
    expect(prompt).toContain('使用 OAuth 还是账号密码？');
    expect(prompt).toContain('使用账号密码');
  });

  it('续用命中（非新会话）→ 不回放问题', async () => {
    const { prompt } = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: { pendingReplies: ['使用账号密码'], waitingQuestion: '使用 OAuth 还是账号密码？' } as any,
        isNewSession: false,
      },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('你此前提出的问题');
  });

  it('问题超 300 字符 → 截断为 300', async () => {
    const { prompt } = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: { pendingReplies: ['答'], waitingQuestion: 'q'.repeat(400) } as any,
        isNewSession: true,
      },
      deps(makeRole()),
    );

    expect(prompt).toContain('你此前提出的问题');
    expect(prompt).toContain('q'.repeat(300));
    expect(prompt).not.toContain('q'.repeat(301));
  });
});

describe('#100: 角色记忆索引常驻注入（memory 段 = per-role MEMORY.md 索引全文）', () => {
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

  const MEMORY_HEADER = '## 角色记忆索引';

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    mockReadIndex.mockResolvedValue('');
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-memory-'));
    fileStore = new FileStore(testDir);
  });

  it('AC1/AC2: 索引存在 → memory 段注入 readIndex 全文（topic 路径 + 一句话摘要行原样保留）+ 段首协议行说明按需语义', async () => {
    const index = '# Role Memory Index\n\n- [auth-flow](topics/auth-flow.md) — OAuth 授权走 PKCE 且不回退账号密码\n- [build-cache](topics/build-cache.md) — pnpm 损坏时用 vitest/tsc-gate 直跑';
    mockReadIndex.mockResolvedValue(index);

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(mockReadIndex).toHaveBeenCalledWith('role-1');
    expect(knowledgeContext).toContain(MEMORY_HEADER);
    // 索引行（topic 路径 + 一句话摘要）原样保留，正文不注入
    expect(knowledgeContext).toContain('- [auth-flow](topics/auth-flow.md) — OAuth 授权走 PKCE 且不回退账号密码');
    expect(knowledgeContext).toContain('- [build-cache](topics/build-cache.md) — pnpm 损坏时用 vitest/tsc-gate 直跑');
    // 段首协议行说明按需语义（正文靠文件工具按需读，不引入语义搜索）
    expect(knowledgeContext).toContain('按需读');
    // 段首协议行位于索引行之前
    expect(knowledgeContext.indexOf(MEMORY_HEADER)).toBeLessThan(knowledgeContext.indexOf('- [auth-flow]'));
  });

  it('AC1: 索引不存在/为空 → 空段（行为同现状，不注入该段）', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain(MEMORY_HEADER);
  });

  it('读盘失败 → 空段 + 不阻断 prompt 组装（knowledge 段仍照常组装）', async () => {
    mockReadIndex.mockRejectedValue(new Error('io error'));

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain(MEMORY_HEADER);
    expect(knowledgeContext).toContain('## 系统约束'); // knowledge 段仍组装，证明 non-blocking
  });

  it('AC1: 索引超有效预算（定额 300 + 池余量）→ 截断并落 prompt:section_trimmed(section=memory, quota=300)', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- [t${i}](topics/t${i}.md) — ${'述'.repeat(80)}`);
    mockReadIndex.mockResolvedValue(`# Role Memory Index\n\n${lines.join('\n')}`);

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain(MEMORY_HEADER);
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('memory');
    expect(events[0].quota).toBe(300);
    // 有效预算 = 定额 300 + 前段（persona 300 + roster 400 + skills 600 + map 800）余量 2100
    expect(events[0].trimmedTokens).toBe(2400);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
  });
});

describe('#119: 契约段生成器（按 WU type）+ 段序稳定性重排', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    mockReadIndex.mockResolvedValue('');
    mockProjectGet.mockResolvedValue(null);
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-contract-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => {
    clearSkills();
  });

  it('AC 段序：稳定前缀 persona → roster → skills → map → memory → knowledge，map 不进 prompt 尾部', async () => {
    // 备齐全部稳定前缀段：persona / roster / skills / map / memory
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-1', name: '#test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(['p-1']),
      createdAt: now, updatedAt: now,
    } as any);
    await fileStore.createProfile({
      id: 'p-1', name: 'p-1', description: '协作成员',
      channels: '[]', status: 'active', provider: 'claude',
      createdAt: now, updatedAt: now,
    } as any);
    writeSkill('feature-dev', '功能开发流程');
    mockProjectGet.mockResolvedValue({
      id: 'proj-1',
      map: { destination: '目标 X', decisions: [], fog: [] },
    });
    mockReadIndex.mockResolvedValue('# Role Memory Index\n\n- [auth-flow](topics/auth-flow.md) — 一句话摘要');

    const { knowledgeContext, prompt } = await composeStepPrompt(
      { wu: makeWu({ channelId: 'ch-1' }), metadata: { pmoId: 'proj-1' } as any },
      deps(makeRole({ persona: '你是开发者。' })),
    );

    const idx = (s: string) => knowledgeContext.indexOf(s);
    expect(idx('## 你的角色')).toBeGreaterThanOrEqual(0);
    expect(idx('## 频道成员与委派')).toBeGreaterThan(idx('## 你的角色'));
    expect(idx('## 本次任务 Skills')).toBeGreaterThan(idx('## 频道成员与委派'));
    expect(idx('## PMO 地图')).toBeGreaterThan(idx('## 本次任务 Skills'));
    expect(idx('## 角色记忆索引')).toBeGreaterThan(idx('## PMO 地图'));
    expect(idx('## 项目上下文')).toBeGreaterThan(idx('## 角色记忆索引'));
    expect(idx('## 系统约束')).toBeGreaterThan(idx('## 项目上下文'));
    // map 移入稳定前缀，不再拼进 prompt 尾部（hint 后）
    expect(prompt).not.toContain('## PMO 地图');
  });

  it('契约段 review → REVIEW_RESULT 协议行，挂 base 后、handoff 前、hint 前，不进稳定前缀', async () => {
    const { prompt, knowledgeContext } = await composeStepPrompt(
      {
        wu: makeWu({ type: 'review' }),
        metadata: {
          stepCount: 2,
          progressLog: [{ step: 1, action: 'progress', summary: '已审', at: '2026-08-12T10:00:00Z' }],
          commitGuardHint: '有未提交改动',
        } as any,
        isNewSession: true,
      },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('REVIEW_RESULT');
    expect(knowledgeContext).not.toContain('## 产出契约');

    const baseIdx = prompt.indexOf('## 当前工作');
    const contractIdx = prompt.indexOf('## 产出契约');
    const handoffIdx = prompt.indexOf('## 前序进展');
    const hintIdx = prompt.indexOf('## 提交提醒');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(contractIdx).toBeGreaterThan(baseIdx);
    expect(handoffIdx).toBeGreaterThan(contractIdx);
    expect(hintIdx).toBeGreaterThan(handoffIdx);
  });

  it('契约段 implement → 测试先行 + Phase commit 格式', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'implement' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('测试先行');
    expect(prompt).toContain('Phase commit');
  });

  it('契约段 decision（决策单）→ 结论摘要格式', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'decision' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('## 结论摘要');
  });

  it('契约段 analysis → research/prototype 产出载体（T3/#125）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'analysis' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('.studio/research/');
    expect(prompt).toContain('prototype/<name>');
  });

  it('未知/无契约 type（task/feature/bug/spec）→ 空段不注入', async () => {
    for (const type of ['task', 'feature', 'bug', 'spec']) {
      const { prompt } = await composeStepPrompt(
        { wu: makeWu({ type }), metadata: {} as any },
        deps(makeRole()),
      );
      expect(prompt).not.toContain('## 产出契约');
    }
  });

  it('#163（T8-E2）契约段 analysis + inspection:true → 巡检契约优先于通用模板', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'analysis' }), metadata: { inspection: true } as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('巡检执行纪律');
    expect(prompt).toContain('分片扫描');
    expect(prompt).toContain('OPPORTUNITY:');
    // 巡检契约替换通用 analysis 模板（不含 prototype 分支文案）
    expect(prompt).not.toContain('prototype/<name>');
  });

  it('契约段 200 软定额 + 模板表仅覆盖 review/implement/decision/analysis', () => {
    expect(SECTION_QUOTAS.contract).toBe(200);
    expect(Object.keys(CONTRACT_TEMPLATES).sort()).toEqual(['analysis', 'decision', 'implement', 'review']);
  });
});

describe('#161 T7-E2: processCheckHint 注入→消费→清除回路', () => {
  let fileStore: FileStore;
  let testDir: string;

  const deps = (role: AgentProfileData): any => ({
    role,
    acceptedTypes: ['implement'],
    fileStore,
    resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '', injectedIds: [] });
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-pch-'));
    fileStore = new FileStore(testDir);
  });

  it('processCheckHint 在场 → 注入「## 过程检查提醒」段（hint 组内），consumedHintUpdates 清除', async () => {
    const { prompt, consumedHintUpdates } = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: { processCheckHint: '过程软观测发现以下提交/契约违规：\n- [tdd-chain] aaaaaaa: 缺 Tested-By' } as any,
        isNewSession: true,
      },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 过程检查提醒');
    expect(prompt).toContain('[tdd-chain] aaaaaaa: 缺 Tested-By');
    // 注入后即消费：清除增量带 processCheckHint 键（undefined 序列化时丢弃）
    expect(consumedHintUpdates).toHaveProperty('processCheckHint', undefined);
  });

  it('processCheckHint 缺省 → 不注入段、不产生清除增量', async () => {
    const { prompt, consumedHintUpdates } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any, isNewSession: true },
      deps(makeRole()),
    );

    expect(prompt).not.toContain('## 过程检查提醒');
    expect(consumedHintUpdates).not.toHaveProperty('processCheckHint');
  });
});
