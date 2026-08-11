/**
 * #91 — composeStepPrompt 函数级测试接缝：分段软定额 + 池内余量共享 + trim 埋点
 *
 * - 六段软定额：skills 600 / persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800
 * - 池内余量共享：前段未用定额流入共享池，后段有效预算 = 定额 + 池（总量封顶 3.5K）
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

const { mockInjectContext, mockAppendJsonl } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: { injectContext: mockInjectContext },
}));

vi.mock('../loop/agent-loop-events', () => ({
  metricsFileStore: { appendJsonl: mockAppendJsonl },
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

  it('六段软定额表：skills 600 / persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800', () => {
    expect(SECTION_QUOTAS).toEqual({
      skills: 600,
      persona: 300,
      roster: 400,
      memory: 300,
      knowledge: 1000,
      handoff: 800,
    });
  });

  it('池内余量共享：前段未用定额流入后段（全空时 knowledge 有效预算 = 2600）', async () => {
    await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      // skills 600 + persona 300 + roster 400 + memory 300 全未用 → 余量入池
      maxTokens: 1000 + 600 + 300 + 400 + 300,
    });
  });

  it('skills 段占定额后余量入池：knowledge 预算 = 1000 + (600 - skillTokens) + 300 + 400 + 300', async () => {
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
      maxTokens: 1000 + (600 - skillTokens) + 300 + 400 + 300,
    });
    // 未截断 → 无 section_trimmed 事件（skill_used 事件不经 mock 的 metricsFileStore 之外的断言）
    expect(sectionTrimmedEvents()).toEqual([]);
  });

  it('skills 段超定额截断并落 prompt:section_trimmed（段名/原始/截断后/定额齐全）', async () => {
    writeSkill('big-skill', '述'.repeat(3000)); // 单块 ~750+ token，超 600 定额

    const { knowledgeContext } = await composeStepPrompt({ wu: makeWu(), metadata: {} as any }, deps(makeRole()));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('skills');
    expect(events[0].quota).toBe(600);
    expect(events[0].trimmedTokens).toBe(600);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].trimmedTokens);
    // skills 定额用尽（余量 0）→ knowledge 预算 = 1000 + 300 + 400 + 300
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 2000,
    });
  });

  it('persona 段超有效预算（定额 300 + skills 余量 600）截断并落事件，定额字段记名义定额 300', async () => {
    const persona = '角'.repeat(4000); // ~1000 token > 有效预算 900

    const { knowledgeContext } = await composeStepPrompt(
      { wu: makeWu(), metadata: {} as any },
      deps(makeRole({ persona })),
    );

    expect(knowledgeContext).toContain('## 你的角色');
    const events = sectionTrimmedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].section).toBe('persona');
    expect(events[0].quota).toBe(300);
    expect(events[0].trimmedTokens).toBe(900);
    expect(events[0].originalTokens).toBeGreaterThan(900);
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
    // 有效预算 = 400 + skills 600 + persona 300 = 1300
    expect(events[0].trimmedTokens).toBe(1300);
    expect(events[0].originalTokens).toBeGreaterThan(1300);
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
