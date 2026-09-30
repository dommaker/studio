/**
 * #91 — composeStepPrompt 函数级测试接缝：分段软定额 + 池内余量共享 + trim 埋点
 *
 * - 九段软定额（harness 1.16.0 estimateTokens 新尺子「旧窗口反推」值，推导即测试见本文件推导块）：
 *   persona 703 / roster 493 / skills 635 / map 1181（#111 T5）/ memory 318 / knowledge 493 /
 *   files 213（#285）/ contract 396（#119）/ handoff 834
 * - 池内余量共享：前段未用定额流入共享池，后段有效预算 = 定额 + 池（总量封顶 = 定额总和 ~5.3K）
 * - 任一段截断落 prompt:section_trimmed 事件（段名/原始 token 数/截断后 token 数/定额），
 *   经 metricsFileStore fire-and-forget 写 studio-events.jsonl
 * - role preset 的 skills/tools/constraints 进入「## 你的角色」段
 * - base prompt 不再引用不存在的 AGENTS.generated.md
 * - #119 段序：稳定前缀 persona → roster → skills → map → memory → knowledge；尾组 base → contract → handoff → hint
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import prompt-composer
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-skills-'));
process.env.SKILLS_DIR = testSkillsDir;
// 显式清理：本文件 `import * as fs` 走原生命名空间，mkdtemp-cleanup 补丁登记不到（见其头注）
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

const { mockInjectContext, mockAppendJsonl, mockProjectGet, mockReadIndex, mockPostWuSystemMessage, mockLogger } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockProjectGet: vi.fn().mockResolvedValue(null),
  mockReadIndex: vi.fn().mockResolvedValue(''),
  mockPostWuSystemMessage: vi.fn().mockResolvedValue(null),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

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

vi.mock('../../workunit/wu-messenger.js', () => ({
  postWuSystemMessage: mockPostWuSystemMessage,
}));

import { FileStore } from '@dommaker/studio-shared';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { estimateTokens } from '@dommaker/harness';
// 推导块的 2K 线常量之一（INJECT_TOKEN_BUDGET 走 vi.importActual，本文件把 knowledge-service 整体 mock 了）
import { INJECTED_TOKEN_BUDGET } from '../../monitoring/monitoring.service.js';

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载
const { composeStepPrompt, SECTION_QUOTAS, CONTRACT_TEMPLATES } = await import('../loop/prompt-composer');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

// #219：STUDIO_HOME 已被 setup 钉到隔离根，SUT 的 MANIFEST 指针/全文路径经 studioPath()
// 动态解析到该根；期望值必须走同一根（os.homedir() 已不再生效）
const studioHome = process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio');

const SKILL_HEADER = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
const SKILL_MANIFEST_POINTER = `完整 skill 清单见 skills MANIFEST.md（${path.join(studioHome, 'skills', 'MANIFEST.md')}）`;

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

/**
 * 与生产 sliceToTokenBudget 同形（新尺子 estimateTokens 版）：预算内最长前缀。
 * 池截断类断言的精确期望值用它计算——切到预算边界的粒度是「字」，放行量常比预算少 1~2 token，
 * 硬编码预算数字当期望值会在定额一变时假红/假绿。
 */
const sliceByNewRuler = (text: string, budget: number): string => {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
};

/** 临时抬本段定额渲染未截断全文，finally 还原（不污染其它用例）。推导块与「先取全文再算精确期望」的用例共用。 */
const renderUntrimmed = async (
  name: keyof typeof SECTION_QUOTAS,
  compose: () => Promise<{ knowledgeContext: string; prompt: string }>,
  extract: (out: { knowledgeContext: string; prompt: string }) => string,
): Promise<string> => {
  const quotas = SECTION_QUOTAS as unknown as Record<string, number>;
  const saved = quotas[name];
  quotas[name] = 50_000_000;
  try {
    const out = await compose();
    const t = extract(out);
    expect(t.length, `${name} 段渲染非空`).toBeGreaterThan(0);
    return t;
  } finally {
    quotas[name] = saved;
  }
};

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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

  it('九段软定额表（harness 1.16.0 新尺子旧窗口反推值，推导过程见下方推导块）：persona 703 / roster 493 / skills 635 / map 1181 / memory 318 / knowledge 493 / files 213（#285）/ contract 396 / handoff 834', () => {
    expect(SECTION_QUOTAS).toEqual({
      persona: 703,
      roster: 493,
      skills: 635,
      map: 1181,
      memory: 318,
      knowledge: 493,
      files: 213,
      contract: 396,
      handoff: 834,
    });
  });

  it('#611: 段构建抛错不再静默——非阻塞兜底 + warn 出声（段名 + 错误）', async () => {
    mockInjectContext.mockRejectedValueOnce(new Error('inject boom'));

    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[prompt-composer] section build failed (non-blocking)',
      expect.objectContaining({ section: 'knowledge', error: 'inject boom' }),
    );
    // 兜底为空段：knowledge 段内容不进 knowledgeContext
    expect(knowledgeContext).not.toContain('## 系统约束');
  });

  it('池内余量共享：前段未用定额流入后段（全空时 knowledge 有效预算 = 3823）', async () => {
    await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // persona 703 + roster 493 + skills 635 + map 1181 + memory 318 全未用 → 余量入池
      maxTokens: SECTION_QUOTAS.knowledge
        + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster + SECTION_QUOTAS.skills
        + SECTION_QUOTAS.map + SECTION_QUOTAS.memory,
    });
  });

  it('skills 段占定额后余量入池：knowledge 预算 = 493 + (1831 - skillTokens) + 1181 + 318', async () => {
    writeSkill('feature-dev', '功能开发流程');
    const skillBlock = `### feature-dev\n功能开发流程｜触发：登录\n全文：${path.join(studioHome, 'skills', 'feature-dev', 'SKILL.md')}`;
    const skillTokens = estimateTokens(SKILL_HEADER) + estimateTokens(skillBlock + '\n\n')
      + estimateTokens(SKILL_MANIFEST_POINTER + '\n\n');

    const { knowledgeContext, skillMatched } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(skillMatched).toEqual(['feature-dev']);
    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // skills 有效预算 = 635 + persona 703 + roster 493 余量 = 1831
      maxTokens: SECTION_QUOTAS.knowledge
        + (SECTION_QUOTAS.skills + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster - skillTokens)
        + SECTION_QUOTAS.map + SECTION_QUOTAS.memory,
    });
    // 未截断 → 无 section_trimmed 事件（#172：skill_used 曝光发射已删除，此处不再出现）
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('skills 段超有效预算（定额 635 + persona 703 + roster 493 余量 = 1831）截断并落 prompt:section_trimmed（段名/原始/截断后/定额齐全）', async () => {
    writeSkill('big-skill', '述'.repeat(6000)); // 单块 ~12000+ token（estimateTokens CJK 2 token/字），超 1831 有效预算

    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    expect(events[0].quota).toBe(SECTION_QUOTAS.skills);
    // 有效预算 = 635 + 703 + 493 = 1831；精确截断值 = 固定开销 + 新尺子预算前缀，与生产同式（字粒度截断可低于预算数个 token）
    const effective = SECTION_QUOTAS.skills + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster;
    const fixedTokens = estimateTokens(SKILL_HEADER) + estimateTokens(SKILL_MANIFEST_POINTER + '\n\n');
    const block = `### big-skill\n${'述'.repeat(6000)}｜触发：登录\n全文：${path.join(studioHome, 'skills', 'big-skill', 'SKILL.md')}`;
    const expectedTrimmed = fixedTokens + estimateTokens(sliceByNewRuler(block, effective - fixedTokens));
    expect(events[0].trimmedTokens).toBe(expectedTrimmed);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    // skills 段截断后仅剩余量 (1831 - expectedTrimmed) 入池 → knowledge 预算
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: SECTION_QUOTAS.knowledge + (effective - expectedTrimmed)
        + SECTION_QUOTAS.map + SECTION_QUOTAS.memory,
    });
  });

  it('persona 段超有效预算（定额 703，首段无余量）截断并落事件，定额字段记名义定额 703', async () => {
    const persona = '角'.repeat(8000); // 16000+ token > 定额 703

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({ persona })),
    );

    expect(knowledgeContext).toContain('## 你的角色');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('persona');
    expect(events[0].quota).toBe(SECTION_QUOTAS.persona);
    const expectedTrimmed = estimateTokens(sliceByNewRuler(`## 你的角色\n\n${persona}`, SECTION_QUOTAS.persona));
    expect(events[0].trimmedTokens).toBe(expectedTrimmed);
    expect(events[0].originalTokens).toBeGreaterThan(SECTION_QUOTAS.persona);
    // persona 余量 (703 - expectedTrimmed) 入池 → knowledge 预算 = 493 + 余量 + roster/skills/map/memory 定额
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: SECTION_QUOTAS.knowledge + (SECTION_QUOTAS.persona - expectedTrimmed)
        + SECTION_QUOTAS.roster + SECTION_QUOTAS.skills + SECTION_QUOTAS.map + SECTION_QUOTAS.memory,
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

    // 先取未截断全文，再按生产同式算精确截断值
    const full = await renderUntrimmed(
      'roster',
      () => composeStepPrompt({ wu: makeWu({ channelId: 'ch-1' }), metadata: {} as any }, deps(makeRole())),
      o => o.knowledgeContext,
    );

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu({ channelId: 'ch-1' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain('## 频道成员与委派');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('roster');
    expect(events[0].quota).toBe(SECTION_QUOTAS.roster);
    // 有效预算 = 493 + persona 703 = 1196
    const effective = SECTION_QUOTAS.roster + SECTION_QUOTAS.persona;
    expect(events[0].trimmedTokens).toBe(estimateTokens(sliceByNewRuler(full, effective)));
    expect(events[0].originalTokens).toBeGreaterThan(effective);
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
    expect(events[0].quota).toBe(SECTION_QUOTAS.knowledge);
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

  describe('九段定额换尺子反推（推导即测试 = 定数正本）', () => {
  // ── harness 1.16.0 换尺子：九段定额反推（推导即测试 = 定数正本） ─────────────
  // 方法（docs/plans/2026-09-harness-116-token-ruler-adoption.md §3；样本口径 = 真渲染，
  // 数据区扒样已证伪，见 .studio/research/2026-09-token-ruler-ratio-measurement.md「第二轮尝试」）：
  //   1. 生产入口 composeStepPrompt 把本段渲染到不截断（临时抬定额，finally 还原），得全文 T；
  //   2. 旧窗口 W = 旧尺子（harness ≤1.15 的旧估算器 estimateText：串里只要有一个中文字
  //      → ceil(len/1.5)，否则 ceil(len/4)）在旧定额下放行的最长前缀，二分与生产
  //      sliceToTokenBudget 同形；
  //   3. 新定额 = estimateTokens(W) —— 新尺子对同一串字的读数。等价换算，不是系数。
  // 取整规则：反推整值直接用、不取整（无残差）；常量偏离反推值即本块红，报错直接给出「该是多少」。
  // knowledge 段与两个 2K 线常量（INJECT_TOKEN_BUDGET 旧 2000 / INJECTED_TOKEN_BUDGET 同数）
  // 用真实渲染器 KnowledgeService.injectContext 产出的注入全文按同法反推。
  // 跨机可复现性：skill 指针/全文路径经 studioPath() 读 STUDIO_HOME，隔离根 mkdtemp 随机后缀会
  // 让渲染宽度逐机漂移；推导块把它钉成定长哨兵路径后可复现，afterEach 必还原，不污染同文件
  // 其它用例（它们仍按真实隔离根断言路径）。同款哨兵再钉两个会改渲染宽度的在场 env：
  // STUDIO_COLLAB_MAX_DEPTH（roster 段尾「委派深度上限 N 跳」现读 process.env）钉成缺省值 2，
  // STUDIO_PROMPT_OVERRIDES_DIR（在场且含 knowledge.rules-section.md 会改 knowledge 段头）钉到
  // 哨兵根下不存在覆盖文件的路径（= 无覆盖回退内置模板，与反推时的口径一致）。
  const DERIVE_STUDIO_HOME = '/studio-home';
  const DERIVE_COLLAB_MAX_DEPTH = '2';
  const DERIVE_PROMPT_OVERRIDES_DIR = '/studio-home/prompt-overrides';
  const prevCollabMaxDepth = process.env.STUDIO_COLLAB_MAX_DEPTH;
  const prevPromptOverridesDir = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  const OLD_QUOTAS = {
    persona: 300, roster: 400, skills: 600, map: 800, memory: 300,
    knowledge: 1000, files: 400, contract: 200, handoff: 800,
  } as const;
  const OLD_INJECT_BUDGET = 2_000;

  const oldRuler = (t: string): number =>
    !t ? 0 : /[一-龥]/.test(t) ? Math.ceil(t.length / 1.5) : Math.ceil(t.length / 4);

  /** 旧尺子在旧预算下放行的最长前缀（与生产 sliceToTokenBudget 同形，只换尺子） */
  const oldWindow = (text: string, budget: number): string => {
    if (oldRuler(text) <= budget) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (oldRuler(text.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo);
  };

  /** 稳定前缀段：其余段全空时 knowledgeContext 即本段全文 */
  const leadT = (
    name: keyof typeof SECTION_QUOTAS,
    wu: any,
    metadata: any,
    role: AgentProfileData,
  ) => renderUntrimmed(
    name,
    () => composeStepPrompt({ wu, metadata }, deps(role)),
    o => o.knowledgeContext,
  );

  // —— 各段真实输入 fixture（内容类对齐 research 比值表：中文自述 / 中文成员说明 /
  //    中英混排 skill 行 / 中文决策行 / 中英混排记忆索引 / ASCII 引用路径 / 契约模板 / 中文进展行）——
  const PERSONA_ZH = '你是本仓的资深工程师，负责 API 与数据层。做事纪律：先查后做，改动前核影响面；收尾跑相关测试并贴原始输出；说人话，不堆术语，不讨好；需求含糊时先列问题再裁决，不猜测；提交直落本地 master，不上线。';

  const ROSTER_DESCS = [
    '审计日志的查询与统计 API 端点，支持按用户、角色、操作类型过滤与分页汇总。',
    '处理钉钉机器人回调，包括 ActionCard 按钮点击的健康检查与忽略提示。',
    '知识引擎：三层分离（Producer → Engine → Consumer），管条目的生产与消费。',
    '认证与会话：注册、登录、Guest Session、JWT 与 OAuth 流程。',
    '项目管理办公室：OKR + 项目 CRUD + 交付守卫，PMO id 即分支名。',
    '频道域：消息创建与路由，replyTo 线程、@mention 派单与合并窗口。',
    'WorkUnit 核心域：任务单元 CRUD、认领与状态机，NEED_INPUT 挂起恢复。',
    '聚合监控指标：M1 飞轮指标与 M2 封装开销，经 HTTP 路由对外。',
    '触发器子系统：SCHEDULE cron + EVENT 事件条件，动作 CREATE/UPDATE/EXECUTE。',
    '转写归档：会话原文落数据区，供 WU 收尾批量提取与 handoff 摘要。',
  ];

  const SKILL_FIXTURES: Array<[string, string]> = [
    ['tdd-implement', '测试先行实现：先写 FAIL 测试（RED）再实现到 GREEN，Phase commit 分批提交'],
    ['code-review', '两轴评审：契约轴 AC 对照 + 规范轴，绿了才 ship'],
    ['diagnosing-bugs', 'bug 快速路：诊断→复现→修复→防回归，复现测试与修复同 commit'],
    ['research', '对高可信一手源做调研，报告落 .studio/research/ 并回挂来源单'],
    ['to-tickets', '把冻结 spec 拆成可独立认领的执行票，票面带 AC 与验收口径'],
    ['grilling', '开图前网状逼问：一次摆出全部决策点，人一次性裁决'],
    ['domain-modeling', '维护领域词表与 CONTEXT.md，术语先入词表再写代码'],
    ['ticket-loop', '多票批处理调度：夜巡每票独立会话，跑完统一 code-review'],
    ['repo-reconcile', '上线前对齐：把散在分支与 worktree 的提交合回 master 并清分支'],
    ['ship-chain', '交付链编排：harness 发包 → studio 采纳 → 上线，分阶段派发'],
  ];

  const MAP_FIXTURE = {
    destination: '把结算链路迁到新引擎并完成双写灰度收敛',
    decisions: Array.from({ length: 10 }, (_, i) => ({
      wuId: `wu-m-${i}`,
      summary: `决策${i}：存储层选 PostgreSQL 而非 MySQL——JSONB 与部分索引够用，pgvector 可后续再上；迁移面已收敛到 ledger 层，双写期对账以新侧为准，回滚窗口 24h 且不双写。`,
      resolvedAt: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    })),
    fog: Array.from({ length: 6 }, (_, i) => ({
      id: `F${i}`,
      question: `雾问题${i}：灰度期间对账口径与回滚窗口如何钉死？`,
      wuId: null,
      status: i % 2 === 0 ? 'open' : 'in-discussion',
    })),
  };

  const MEMORY_FIXTURE = `# Role Memory Index\n\n${Array.from({ length: 30 }, (_, i) => i % 2 === 0
    ? `- [auth-flow-${i}](topics/auth-flow-${i}.md) — OAuth 授权走 PKCE 且不回退账号密码，redirect_uri 必须逐字一致`
    : `- [build-cache-${i}](topics/build-cache-${i}.md) — pnpm 损坏时用 vitest/tsc-gate 直跑，别等 install 全量恢复`).join('\n')}`;

  const FILES_FIXTURE = {
    workspaceRoot: '/repo/ws',
    fileRefs: Array.from({ length: 30 }, (_, i) => ({
      repo: '/repo/ws',
      path: `apps/api/src/modules/knowledge/engine/query-part-${String(i).padStart(2, '0')}.ts`,
    })),
  };

  // knowledge 注入正文内容类（research：knowledge 条目正文 新÷旧 中位 0.65——英文为主夹少量
  // 中文时，旧尺子「见一个中文整串除 1.5」严重高估，等价窗口即变小）
  const KNOWLEDGE_RULES = [
    'Non-blocking section builds must log loudly with the section name and error — a silent catch let the R4 inject bug lurk for months before anyone noticed（静默 catch 是 bug 潜伏数月的土壤，段构建失败必须出声）.',
    'All runtime data paths resolve through studioPath()/studioDir(); never hardcode the data root in code, docs or tests — test isolation pins STUDIO_HOME to an ephemeral root and hardcoded paths silently write through into production data（硬编码即穿透生产数据区）.',
    'vitest module mocks are per test file and resolved-path based: vi.mock on a specifier without .js still intercepts the same resolved module id — keep mock paths aligned with import specifiers or the SUT loads the real module and hits the disk.',
    'FileKnowledgeStore.list() is readIndex plus one readFileSync per entry (N+1 sync reads); injectContext scans four times per agent step, so the mtime memo wrapper is mandatory — never bypass it with a fresh store instance.',
    'Deploy webhook accepts push to refs/heads/master only and returns 202 before the script starts; the script must be idempotent and reentrant because webhook and cron can race（撞窗时脚本必须幂等可重入）.',
    'Session resume keys on stored provider session id; a resume miss with stepCount>0 is the only reliable handoff signal — replay 前序进展 from metadata.progressLog instead of restarting the unit from scratch.',
    'recordReference closes the maturity loop on every injected id; a new consumer that forgets it makes proven entries decay to stale and the flywheel starves silently（引用回报断链会让成熟度循环停摆）.',
    'git commit trailers are compliance data — grep-able and machine-checkable: governance edits require the Governance-Approved trailer, and a missing trailer is a policy violation, not formatting noise.',
    'When a corrupted pnpm store breaks install, run tsc/vitest by direct node invocation — do not block on a full reinstall; CI cache invalidation is the usual root cause.',
    'Token budgets must name which ruler measures them: estimateTokens counts per code point (CJK 2, others 0.25, ceil) while the retired estimator collapsed whole strings to len/1.5 — swapping rulers silently rescales every threshold, so convert each section quota one by one（换尺子必须逐段换算，不能一把系数套到底）.',
    'Reference counts shown to the agent must come from the same store the injector reads; pointing the hint at an index built elsewhere teaches the model to search a graveyard.',
    'Every fire-and-forget metrics append needs a catch — an unhandled rejection inside a section builder would tear down the whole step loop for one missing jsonl file.',
  ].map((content, i) => ({
    id: `rule-${i}`,
    content,
    type: 'guideline',
    sourceReferences: [{ timestamp: '2026-09-01T00:00:00Z' }],
    status: 'published',
    maturity: i % 3 === 0 ? 'proven' : 'verified',
  }));

  const KNOWLEDGE_CONTEXTS = [
    'provider default is claude; the roster section falls back to all active profiles when channel.members is empty（历史频道未回填成员时的过渡口径）.',
    'studio-events.jsonl path is resolved per call by resolveStudioEventsFile(); STUDIO_EVENTS_FILE env overrides it for test isolation — never freeze the path at module load.',
    'Worktree agent CLI starts with the worktree as cwd and loads .claude/settings.json, where the local-rag MCP server is registered by propagateHarnessConfig.',
    'PMO id doubles as the branch name; requirements aggregate by REQ-<n>; status derives from the WorkUnit ledger rather than manual flags.',
  ].map((content, i) => ({
    id: `ctx-${i}`,
    content,
    type: 'preference',
    sourceReferences: [{ timestamp: '2026-09-01T00:00:00Z' }],
    status: 'published',
    maturity: 'active',
  }));

  const KNOWLEDGE_SIGNALS = [
    { id: 'sig-settle', summary: '结算双写灰度：对账以新侧为准，回滚窗口 24h', status: 'published', maturity: 'proven' },
    { id: 'sig-memory', summary: 'MEMORY.md 索引常驻注入，正文按需读', status: 'published', maturity: 'proven' },
    { id: 'sig-lease', summary: '租约 fencing：心跳 30s，fencing token 校验', status: 'published', maturity: 'verified' },
    { id: 'sig-distill', summary: 'WU done 钩子门槛检测零 LLM，命中才发提案卡', status: 'published', maturity: 'verified' },
    { id: 'sig-ship', summary: 'master 受保护禁直推，ship 走 PR 自动合并', status: 'published', maturity: 'active' },
  ];

  const HANDOFF_FIXTURE = Array.from({ length: 25 }, (_, i) => ({
    step: i + 1,
    action: i % 4 === 3 ? 'complete' : 'progress',
    summary: [
      '完成数据层迁移，双写校验通过',
      '接口层接线 recordResult，落盘幂等验证',
      '路由层合并窗口歧义守卫上线',
      '补齐 CONTEXT.md 口径与漂移项',
      '修 lease-heartbeat 与 fencing 竞态',
    ][i % 5] + `（第 ${i + 1} 轮：TDD 链全绿，Tested-By trailer 已带）`,
    at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
  }));

  beforeEach(() => {
    mockInjectContext.mockResolvedValue({ prompt: '', injectedIds: [] });
    mockReadIndex.mockResolvedValue('');
    mockProjectGet.mockResolvedValue(null);
    process.env.STUDIO_HOME = DERIVE_STUDIO_HOME;
    process.env.STUDIO_COLLAB_MAX_DEPTH = DERIVE_COLLAB_MAX_DEPTH;
    process.env.STUDIO_PROMPT_OVERRIDES_DIR = DERIVE_PROMPT_OVERRIDES_DIR;
  });
  afterEach(() => {
    process.env.STUDIO_HOME = studioHome;
    if (prevCollabMaxDepth === undefined) delete process.env.STUDIO_COLLAB_MAX_DEPTH;
    else process.env.STUDIO_COLLAB_MAX_DEPTH = prevCollabMaxDepth;
    if (prevPromptOverridesDir === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
    else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevPromptOverridesDir;
  });

  it('推导表：九段定额 + 两个 2K 线常量 = estimateTokens(旧窗口)，常量必须等于反推值', async () => {
    const rows: string[] = [];
    const record = (section: string, old: number, T: string, sample: string, final: number): number => {
      const W = oldWindow(T, old);
      const derived = estimateTokens(W);
      rows.push(`${section.padEnd(22)} old=${String(old).padStart(4)}  旧窗口=${String(W.length).padStart(5)}字  反推=${String(derived).padStart(5)}  现常量=${String(final).padStart(5)}  样本=${sample}`);
      return derived;
    };

    const dPersona = record('persona', OLD_QUOTAS.persona,
      await leadT('persona', makeWu(), {} as any, makeRole({ persona: PERSONA_ZH.repeat(10) })),
      'buildPersonaSection(role.persona=中文自述句×10)', SECTION_QUOTAS.persona);

    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-derive', name: '#derive', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(ROSTER_DESCS.map((_, i) => `dm-${i}`)),
      createdAt: now, updatedAt: now,
    } as any);
    for (let i = 0; i < ROSTER_DESCS.length; i++) {
      await fileStore.createProfile({
        id: `dm-${i}`, name: `成员-${i}`, description: ROSTER_DESCS[i],
        channels: '[]', status: 'active', provider: 'claude',
        createdAt: now, updatedAt: now,
      } as any);
    }
    const dRoster = record('roster', OLD_QUOTAS.roster,
      await leadT('roster', makeWu({ channelId: 'ch-derive' }), {} as any, makeRole()),
      'buildRosterSection(10 名 active 成员：中文模块说明 + DELEGATE 协议尾)', SECTION_QUOTAS.roster);

    for (const [name, description] of SKILL_FIXTURES) {
      writeSkillMeta(name, { description, agentTypes: ['feature'], triggers: ['登录'] });
    }
    const dSkills = record('skills', OLD_QUOTAS.skills,
      await leadT('skills', makeWu(), {} as any, makeRole()),
      'buildSkillSection(10 条中英混排索引行 + MANIFEST 指针，STUDIO_HOME=哨兵)', SECTION_QUOTAS.skills);
    clearSkills();

    mockProjectGet.mockResolvedValue({ id: 'proj-derive', map: MAP_FIXTURE });
    const dMap = record('map', OLD_QUOTAS.map,
      await leadT('map', makeWu(), { pmoId: 'proj-derive' } as any, makeRole()),
      'buildPmoMapSection(destination + 10 条中文决策行(N 封顶) + 6 条开放雾)', SECTION_QUOTAS.map);
    mockProjectGet.mockResolvedValue(null);

    mockReadIndex.mockResolvedValue(MEMORY_FIXTURE);
    const dMemory = record('memory', OLD_QUOTAS.memory,
      await leadT('memory', makeWu(), {} as any, makeRole()),
      'buildMemorySection(MEMORY.md 索引 30 行：topic 路径 + 中英混排摘要)', SECTION_QUOTAS.memory);
    // 后续步骤复位：leadT 只抬本段定额，前段 mock 若不复位会串进本段 knowledgeContext
    mockReadIndex.mockResolvedValue('');

    const actualKs = await vi.importActual<any>('../../knowledge/knowledge-service.js');
    const ks = new actualKs.KnowledgeService({
      store: { list: vi.fn(() => []), get: vi.fn(), save: vi.fn(), update: vi.fn(), delete: vi.fn() } as any,
      lifecycle: { recordReference: vi.fn(), shouldAutoPromote: vi.fn(() => false) } as any,
      ingest: { ingestEntry: vi.fn() } as any,
      linter: { validateEntry: vi.fn(() => []) } as any,
      query: {
        queryEntries: vi.fn()
          .mockResolvedValueOnce(KNOWLEDGE_RULES)
          .mockResolvedValueOnce(KNOWLEDGE_CONTEXTS),
        listEntries: vi.fn().mockResolvedValue([]),
        getIndexes: vi.fn().mockReturnValue(KNOWLEDGE_SIGNALS),
        count: vi.fn().mockResolvedValue(37),
      } as any,
      eventEmitter: { emit: vi.fn() } as any,
    });
    const injected = await ks.injectContext('implement', { maxTokens: 50_000_000 });
    // 全量放行（未裁条）：usage 原始 = 截后，否则「渲染到不截断」不成立
    expect(injected.usage?.keptTokens).toBe(injected.usage?.originalTokens);
    const knowledgeT = injected.prompt;
    const dKnowledge = record('knowledge', OLD_QUOTAS.knowledge, knowledgeT,
      'KnowledgeService.injectContext(12 rule + 4 context + 5 signal + 37 reference 全量渲染)', SECTION_QUOTAS.knowledge);
    const dInject = record('INJECT_TOKEN_BUDGET', OLD_INJECT_BUDGET, knowledgeT,
      '同上：同一 knowledge 全文 T，旧 2000', actualKs.INJECT_TOKEN_BUDGET);
    record('INJECTED_TOKEN_BUDGET', OLD_INJECT_BUDGET, knowledgeT,
      '同上（与 INJECT_TOKEN_BUDGET 必须同数）', INJECTED_TOKEN_BUDGET);

    const dFiles = record('files', OLD_QUOTAS.files,
      await leadT('files', makeWu(), FILES_FIXTURE as any, makeRole()),
      'buildFilesSection(30 条 ASCII 引用路径 + 本工程中文标注 + D6 固定行)', SECTION_QUOTAS.files);

    // contract 段内容随 WU type 变化：定额须覆盖全部真实模板里反推值最大者（取 max 规则）
    let dContract = 0;
    let contractMaxType = '';
    const contractCases: Array<[string, any]> = [
      ...Object.keys(CONTRACT_TEMPLATES).map((t): [string, any] => [t, {}]),
      ['inspection', { inspection: true }],
    ];
    for (const [type, metadata] of contractCases) {
      const wu = makeWu({ type: type === 'inspection' ? 'analysis' : type });
      const T = await renderUntrimmed(
        'contract',
        () => composeStepPrompt({ wu, metadata: metadata as any }, deps(makeRole())),
        o => o.prompt.slice(o.prompt.indexOf('## 产出契约')),
      );
      const d = estimateTokens(oldWindow(T, OLD_QUOTAS.contract));
      if (d >= dContract) { dContract = d; contractMaxType = type; }
    }
    rows.push(`contract                 old=${String(OLD_QUOTAS.contract).padStart(4)}  旧窗口=-     反推=${String(dContract).padStart(5)}  现常量=${String(SECTION_QUOTAS.contract).padStart(5)}  样本=buildContractSection(取 ${contractCases.length} 个真实模板反推最大值，最大者=${contractMaxType})`);

    const dHandoff = record('handoff', OLD_QUOTAS.handoff,
      await renderUntrimmed(
        'handoff',
        () => composeStepPrompt(
          { wu: makeWu(), metadata: { stepCount: 25, progressLog: HANDOFF_FIXTURE } as any, isNewSession: true },
          deps(makeRole()),
        ),
        o => o.prompt.slice(o.prompt.indexOf('## 前序进展')),
      ),
      'buildHandoffSection(25 条中文进展行)', SECTION_QUOTAS.handoff);

    console.log(`[token-ruler-derive] 哨兵 STUDIO_HOME=${DERIVE_STUDIO_HOME}\n${rows.join('\n')}`);

    // —— 推导即守卫：常量必须等于反推值（改尺子/改常量后，此处直接报出该是多少）——
    expect(SECTION_QUOTAS.persona, `persona 应为反推值 ${dPersona}`).toBe(dPersona);
    expect(SECTION_QUOTAS.roster, `roster 应为反推值 ${dRoster}`).toBe(dRoster);
    expect(SECTION_QUOTAS.skills, `skills 应为反推值 ${dSkills}`).toBe(dSkills);
    expect(SECTION_QUOTAS.map, `map 应为反推值 ${dMap}`).toBe(dMap);
    expect(SECTION_QUOTAS.memory, `memory 应为反推值 ${dMemory}`).toBe(dMemory);
    expect(SECTION_QUOTAS.knowledge, `knowledge 应为反推值 ${dKnowledge}`).toBe(dKnowledge);
    expect(SECTION_QUOTAS.files, `files 应为反推值 ${dFiles}`).toBe(dFiles);
    expect(SECTION_QUOTAS.contract, `contract 应为反推值（模板最大值）${dContract}`).toBe(dContract);
    expect(SECTION_QUOTAS.handoff, `handoff 应为反推值 ${dHandoff}`).toBe(dHandoff);

    expect(actualKs.INJECT_TOKEN_BUDGET, `INJECT_TOKEN_BUDGET 应为 knowledge 全文旧 2000 窗口反推值 ${dInject}`).toBe(dInject);
    expect(INJECTED_TOKEN_BUDGET, `INJECTED_TOKEN_BUDGET 应与之同数 ${dInject}`).toBe(dInject);
    expect(INJECTED_TOKEN_BUDGET).toBe(actualKs.INJECT_TOKEN_BUDGET);
  }, 30_000);

  it('方向钉住：ASCII 为主的 files 段反推值 < 旧值，中文为主的 persona/handoff 段 > 旧值', () => {
    expect(SECTION_QUOTAS.files / OLD_QUOTAS.files).toBeLessThan(1);
    expect(SECTION_QUOTAS.persona / OLD_QUOTAS.persona).toBeGreaterThan(1);
    expect(SECTION_QUOTAS.handoff / OLD_QUOTAS.handoff).toBeGreaterThan(1);
    // 反证「统一 ×3」：纯中文最坏比值 3.00 若全局套用，files 段会凭空放行约 3 倍内容
    expect(SECTION_QUOTAS.files).toBeLessThan(OLD_QUOTAS.files * 3);
  });
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
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
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

  it('#172（#60 决策 Q2）：曝光事件发射已删除 —— skill 注入不再产 knowledge:skill_used', async () => {
    writeSkill('feature-dev', '功能开发流程');

    const { skillMatched } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));
    expect(skillMatched).toEqual(['feature-dev']); // 注入本身不动（prompt 策略超本票）

    const skillUsedEvents = mockAppendJsonl.mock.calls
      .map(c => c[1])
      .filter((e: any) => e.type === 'knowledge:skill_used');
    expect(skillUsedEvents).toEqual([]);
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
    // 预裁剪后仍受 #91 定额截断（domain-big 单块超 1831 有效预算 = 635+703+493 → 落 skills 截断埋点）
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    const effective = SECTION_QUOTAS.skills + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster;
    const fixedTokens = estimateTokens(SKILL_HEADER) + estimateTokens(SKILL_MANIFEST_POINTER + '\n\n');
    const domainBlock = `### domain-big\n${'述'.repeat(6000)}\n全文：${path.join(studioHome, 'skills', 'domain-big', 'SKILL.md')}`;
    expect(events[0].trimmedTokens).toBe(
      fixedTokens + estimateTokens(sliceByNewRuler(domainBlock, effective - fixedTokens)),
    );
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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

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
    // 60 条开放雾（≈2520 tok，estimateTokens 逐码点口径）+ 10 条决策（≈310/条）→ 原始 ~5750 tok > 3012 有效预算（map 1181 + persona/roster/skills 全空余量 1831 入池）；
    // 决策从旧裁到只剩最新（fog+固定开销自身未超预算 → 不触发兜底整段截）
    const fog = Array.from({ length: 60 }, (_, i) => ({
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

    // fog 全保留（60 条一条不少）
    for (let i = 0; i < 60; i++) {
      expect(knowledgeContext).toContain(`雾问题-${String(i).padStart(2, '0')}：`);
    }
    // decisions 保最新、从旧截：最新在，最旧不在
    expect(knowledgeContext).toContain('决策结论-9');
    expect(knowledgeContext).not.toContain('决策结论-0');
    // 截断埋点：section=map / quota=1181 / 截后 ≤ 3012（map 有效预算）< 原始
    const effective = SECTION_QUOTAS.map + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster + SECTION_QUOTAS.skills;
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('map');
    expect(events[0].quota).toBe(SECTION_QUOTAS.map);
    expect(events[0].trimmedTokens).toBeLessThanOrEqual(effective);
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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

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

  it('AC1: 索引超有效预算（定额 318 + 池余量）→ 截断并落 prompt:section_trimmed(section=memory, quota=318)', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- [t${i}](topics/t${i}.md) — ${'述'.repeat(80)}`);
    const index = `# Role Memory Index\n\n${lines.join('\n')}`;
    mockReadIndex.mockResolvedValue(index);

    // 先取未截断全文，再按生产同式算精确截断值
    const full = await renderUntrimmed(
      'memory',
      () => composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole())),
      o => o.knowledgeContext,
    );

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain(MEMORY_HEADER);
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('memory');
    expect(events[0].quota).toBe(SECTION_QUOTAS.memory);
    // 有效预算 = 定额 318 + 前段（persona 703 + roster 493 + skills 635 + map 1181）余量 3012 = 3330
    const effective = SECTION_QUOTAS.memory + SECTION_QUOTAS.persona + SECTION_QUOTAS.roster
      + SECTION_QUOTAS.skills + SECTION_QUOTAS.map;
    expect(events[0].trimmedTokens).toBe(estimateTokens(sliceByNewRuler(full, effective)));
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
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
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
    expect(prompt).toContain('本环节标准打法：code-review');
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
    expect(prompt).toContain('本环节标准打法：tdd-implement');
  });

  it('契约段 decision（决策单）→ 结论摘要格式', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'decision' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('## 结论摘要');
  });

  it('契约段 spec（成文单）→ TASK 物化行格式（#463：确认弹窗卡片墙的数据源）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'spec' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('TASK:');
    expect(prompt).toContain('AC:');
  });

  it('契约段 analysis → research/prototype 产出载体（T3/#125）+ bug 路由规则与升级触发器（#121）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'analysis' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('.studio/research/');
    expect(prompt).toContain('prototype/<name>');
    // #121：bug 默认快速路 + 升级触发器（根因在需求/设计层 → 转决策单或开图，诊断事实随票携带）
    expect(prompt).toContain('bug 路由');
    expect(prompt).toContain('快速路');
    expect(prompt).toContain('升级触发器');
    expect(prompt).toContain('随票携带');
  });

  it('契约段 bug → 复现测试先行 + 防回归测试随修复同 commit（#121）', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'bug' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('复现测试先行');
    expect(prompt).toContain('防回归测试随修复同 commit');
    expect(prompt).toContain('本环节标准打法：diagnosing-bugs');
  });

  it('未知/无契约 type（task/feature）→ 空段不注入（spec 自 #463 起有物化清单契约）', async () => {
    for (const type of ['task', 'feature']) {
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

  it('契约段 plan（#471 一脉会话规划单）→ TASK/FOG 输出协议 + 台账续跑指引', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'plan' }), metadata: {} as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('## 产出契约');
    expect(prompt).toContain('TASK:');
    expect(prompt).toContain('FOG:');
    expect(prompt).toContain('.studio/specs/');
  });

  it('#567 契约段 plan 含方向锁定段（DIRECTION 协议行，在裁决轮段之前）', async () => {
    const plan = CONTRACT_TEMPLATES.plan;
    expect(plan).toContain('DIRECTION:');
    expect(plan).toContain('方向锁定');
    const dirIdx = plan.indexOf('方向锁定');
    const rulingIdx = plan.indexOf('裁决轮（fog 调研齐后出一次');
    expect(dirIdx).toBeGreaterThanOrEqual(0);
    expect(rulingIdx).toBeGreaterThan(dirIdx);

    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'plan' }), metadata: {} as any },
      deps(makeRole()),
    );
    expect(prompt).toContain('DIRECTION:');
  });

  it('#567 directionPick:false → 契约段方向锁定段替换为「本单已关闭方向锁定」提示', async () => {
    const { prompt } = await composeStepPrompt(
      { wu: makeWu({ type: 'plan' }), metadata: { directionPick: false } as any },
      deps(makeRole()),
    );

    expect(prompt).toContain('本单已关闭方向锁定');
    expect(prompt).not.toContain('DIRECTION:');
  });

  it('#567 AC6：非 plan 类型契约模板不含方向锁定段（零改动证明）', () => {
    for (const [type, template] of Object.entries(CONTRACT_TEMPLATES)) {
      if (type === 'plan') continue;
      expect(template, `${type} 模板不应含 DIRECTION 段`).not.toContain('DIRECTION:');
      expect(template, `${type} 模板不应含方向锁定`).not.toContain('方向锁定');
    }
  });

  it('契约段软定额 396（旧窗口反推，模板最大值口径）+ 模板表覆盖 review/implement/decision/analysis/bug/spec/plan（#121/#463/#471）', () => {
    expect(SECTION_QUOTAS.contract).toBe(396);
    expect(Object.keys(CONTRACT_TEMPLATES).sort()).toEqual(['analysis', 'bug', 'decision', 'implement', 'plan', 'review', 'spec']);
  });

  it('契约段尾标准打法指引行（不受定额截断影响，直接断言模板表）：implement/bug/plan/analysis/review → 对应 skill', () => {
    expect(CONTRACT_TEMPLATES.implement).toContain('本环节标准打法：tdd-implement（索引见 skills 段，先 loadSkill 读全文再开工）。');
    expect(CONTRACT_TEMPLATES.bug).toContain('本环节标准打法：diagnosing-bugs（索引见 skills 段，先 loadSkill 读全文再开工）。');
    expect(CONTRACT_TEMPLATES.plan).toContain('本环节标准打法：requirement-clarify + to-tickets（索引见 skills 段，先 loadSkill 读全文再开工）。');
    expect(CONTRACT_TEMPLATES.analysis).toContain('本环节标准打法：research（索引见 skills 段，先 loadSkill 读全文再开工）。');
    expect(CONTRACT_TEMPLATES.review).toContain('本环节标准打法：code-review（索引见 skills 段，先 loadSkill 读全文再开工）。');
    // decision/spec/巡检变体（INSPECTION_CONTRACT）无对应打法 skill，不加指引行
    expect(CONTRACT_TEMPLATES.decision).not.toContain('本环节标准打法');
    expect(CONTRACT_TEMPLATES.spec).not.toContain('本环节标准打法');
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

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

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

describe('#285（决策 #257 D1/D2/D4/D6/D7/D9）：files 段「## 引用文件」', () => {
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

  const FILES_HEADER = '## 引用文件';
  // D6 原文（逐字，与 #285 票体固定行一致）
  const FILES_FOOTER = '以下引用中位于本工程之外的文件为只读上下文，请勿修改；跨仓写入请显式提出并等人确认。大文件请按需分段读取，不要全文吞入。';

  /** 让 knowledge 段吃满有效预算（3823 = 493 定额 + 前段全空余量 3330），files 段有效预算 = 裸定额 213 */
  const saturateKnowledgeBudget = () => {
    mockInjectContext.mockResolvedValue({
      prompt: '## 系统约束\n- test rule',
      injectedIds: [],
      usage: { originalTokens: 3823, keptTokens: 3823 },
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearSkills();
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    mockReadIndex.mockResolvedValue('');
    mockProjectGet.mockResolvedValue(null);
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-files-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

  it('段内容：绝对路径 = repo/path（尾斜杠归一防双斜杠），本工程内标相对路径，跨仓标「位于本工程之外」，段尾固定行逐字', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: {
          workspaceRoot: '/repo/ws/', // 尾斜杠写法差，归一后与 ref.repo 相等
          fileRefs: [
            { repo: '/repo/ws', path: 'src/a.ts' },
            { repo: '/repo/other/', path: 'lib/b.ts' },
          ],
        } as any,
      },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain(FILES_HEADER);
    expect(knowledgeContext).toContain('- /repo/ws/src/a.ts（本工程内，相对路径：src/a.ts）');
    expect(knowledgeContext).toContain('- /repo/other/lib/b.ts（位于本工程之外）');
    expect(knowledgeContext).toContain(FILES_FOOTER);
    // 固定行在段尾（引用块之后）
    expect(knowledgeContext.indexOf(FILES_FOOTER)).toBeGreaterThan(knowledgeContext.indexOf('- /repo/other/lib/b.ts'));
  });

  it('workspaceRoot 缺失 → 全部按「位于本工程之外」标注', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: { fileRefs: [{ repo: '/repo/ws', path: 'src/a.ts' }] } as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).toContain('- /repo/ws/src/a.ts（位于本工程之外）');
    expect(knowledgeContext).not.toContain('本工程内');
  });

  it('位置（D1）：files 段在 knowledge 段之后（稳定前缀最末，knowledgeContext 内序）', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: { fileRefs: [{ repo: '/repo/ws', path: 'src/a.ts' }] } as any },
      deps(makeRole()),
    );

    const idx = (s: string) => knowledgeContext.indexOf(s);
    expect(idx('## 系统约束')).toBeGreaterThanOrEqual(0);
    expect(idx(FILES_HEADER)).toBeGreaterThan(idx('## 系统约束'));
  });

  it('无 fileRefs → 不注入段（行为同现状）', async () => {
    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole()),
    );

    expect(knowledgeContext).not.toContain(FILES_HEADER);
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('畸形 fileRefs（非数组 / 畸形条目）→ 不炸，畸形条目跳过', async () => {
    const notArray = await composeStepPrompt(
      { wu: makeWu(), metadata: { fileRefs: 'oops' } as any },
      deps(makeRole()),
    );
    expect(notArray.knowledgeContext).not.toContain(FILES_HEADER);

    const mixed = await composeStepPrompt(
      {
        wu: makeWu(),
        metadata: {
          fileRefs: [
            null,
            { repo: '/repo/ws' }, // 缺 path
            { path: 'src/a.ts' }, // 缺 repo
            42,
            { repo: '/repo/ws', path: 'src/ok.ts' },
          ],
        } as any,
      },
      deps(makeRole()),
    );
    expect(mixed.knowledgeContext).toContain('- /repo/ws/src/ok.ts');
    expect(mixed.knowledgeContext).not.toContain('null');
  });

  it('截断（D2/D4）：超 213 定额 → 保注入序前缀 + 段尾「另有 N 条引用未注入」+ section_trimmed payload 含 keptCount/droppedPaths(≤5)/droppedCount', async () => {
    saturateKnowledgeBudget(); // files 有效预算 = 213
    const refs = Array.from({ length: 40 }, (_, i) => ({
      repo: '/repo/ws',
      path: `src/very/deeply/nested/directory/structure/for/budget/file-${String(i).padStart(2, '0')}.ts`,
    }));

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: { workspaceRoot: '/repo/ws', fileRefs: refs } as any },
      deps(makeRole()),
    );

    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('files');
    expect(events[0].quota).toBe(SECTION_QUOTAS.files);
    expect(events[0].trimmedTokens).toBeLessThanOrEqual(SECTION_QUOTAS.files);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    const { keptCount, droppedPaths, droppedCount } = events[0];
    expect(keptCount).toBeGreaterThan(0);
    expect(keptCount).toBeLessThan(40);
    expect(droppedCount).toBe(40 - keptCount);
    expect(droppedPaths.length).toBeLessThanOrEqual(5);
    expect(droppedPaths[0]).toBe(`/repo/ws/${refs[keptCount].path}`); // 首条未注入引用的绝对路径

    // 保注入序前缀：第 keptCount-1 条在，第 keptCount 条不在
    expect(knowledgeContext).toContain(`file-${String(keptCount - 1).padStart(2, '0')}.ts`);
    expect(knowledgeContext).not.toContain(`file-${String(keptCount).padStart(2, '0')}.ts`);
    // 段尾标注 + 固定行保留
    expect(knowledgeContext).toContain(`另有 ${droppedCount} 条引用未注入`);
    expect(knowledgeContext).toContain(FILES_FOOTER);
  });

  it('播报（D4）：截断且首步（stepCount 缺失）→ 频道播报一次「引用文件较多，已注入前 N 条」', async () => {
    saturateKnowledgeBudget();
    const refs = Array.from({ length: 40 }, (_, i) => ({
      repo: '/repo/ws',
      path: `src/very/deeply/nested/directory/structure/for/budget/file-${String(i).padStart(2, '0')}.ts`,
    }));

    await composeStepPrompt(
      { wu: makeWu({ channelId: 'ch-1' }), metadata: { workspaceRoot: '/repo/ws', fileRefs: refs } as any },
      deps(makeRole()),
    );

    expect(mockPostWuSystemMessage).toHaveBeenCalledTimes(1);
    const [wuArg, content, opts] = mockPostWuSystemMessage.mock.calls[0];
    expect(wuArg.id).toBe('wu-1');
    const events = sectionTrimmedEvents();
    expect(content).toBe(`引用文件较多，已注入前 ${events[0].keptCount} 条`);
    expect(opts.fileStore).toBe(fileStore);
  });

  it('播报只在第一步：stepCount>0 时截断也不重复播报', async () => {
    saturateKnowledgeBudget();
    const refs = Array.from({ length: 40 }, (_, i) => ({
      repo: '/repo/ws',
      path: `src/very/deeply/nested/directory/structure/for/budget/file-${String(i).padStart(2, '0')}.ts`,
    }));

    await composeStepPrompt(
      {
        wu: makeWu({ channelId: 'ch-1' }),
        metadata: { workspaceRoot: '/repo/ws', fileRefs: refs, stepCount: 2 } as any,
      },
      deps(makeRole()),
    );

    expect(sectionTrimmedEvents()).toHaveLength(1); // 埋点照落
    expect(mockPostWuSystemMessage).not.toHaveBeenCalled();
  });

  it('wu.channelId 缺失 → 不播报（埋点照落）', async () => {
    saturateKnowledgeBudget();
    const refs = Array.from({ length: 40 }, (_, i) => ({
      repo: '/repo/ws',
      path: `src/very/deeply/nested/directory/structure/for/budget/file-${String(i).padStart(2, '0')}.ts`,
    }));

    await composeStepPrompt(
      { wu: makeWu({ channelId: null }), metadata: { workspaceRoot: '/repo/ws', fileRefs: refs } as any },
      deps(makeRole()),
    );

    expect(sectionTrimmedEvents()).toHaveLength(1);
    expect(mockPostWuSystemMessage).not.toHaveBeenCalled();
  });

  it('未截断（少量引用）→ 不播报、无 files 截断埋点', async () => {
    await composeStepPrompt(
      {
        wu: makeWu({ channelId: 'ch-1' }),
        metadata: { fileRefs: [{ repo: '/repo/ws', path: 'src/a.ts' }] } as any,
      },
      deps(makeRole()),
    );

    expect(mockPostWuSystemMessage).not.toHaveBeenCalled();
    expect(sectionTrimmedEvents().filter(e => e.section === 'files')).toEqual([]);
  });
});
