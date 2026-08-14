/**
 * §10 P0 — agentStep skill 索引注入（index-on-demand）
 * → 决策 7/11/13 重构：匹配从 claim 挪到 step 时（消竞态、吃到 skill 库最新版）
 *
 * - 域匹配命中（wu.type/role.acceptedTypes 经 normalizeToStage 归一化 ∩ skill.agentTypes）：
 *   knowledgeContext 含 `## 本次任务 Skills`（在 `## 项目上下文` 之前）+ 协议说明行
 *   + 索引块（name + description + triggers 摘要 + SKILL.md 指针（studioPath 解析的绝对路径）），不含正文；
 *   injectContext 收到分段定额 + 池内余量共享后的 maxTokens（#91：map 800（#111 T5）/ skills 600 /
 *   persona 300 / roster 400 / memory 300 / knowledge 1000 / handoff 800，前段未用定额流入后段）
 * - metadata.matchedSkills 不再作为注入输入（step 时实时计算；匹配名单经 metadataUpdates 落盘供度量）
 * - +skill 显式点名 step 时从 wu.scope 解析（parseSkillHintsFromScope），排最高优先级
 * - 决策 13：`## 你的角色` 段（persona ?? description，为空省略）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import agent-loop
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-skills-'));
process.env.SKILLS_DIR = testSkillsDir;
// 事件文件隔离：skill 注入度量会写 STUDIO_EVENTS_JSONL，指向临时文件避免污染生产事件流
process.env.STUDIO_EVENTS_JSONL = path.join(testSkillsDir, 'studio-events.jsonl');

const SKILL_BODY = '## 执行步骤\n\n1. 读需求\n2. 写代码\n3. 跑测试';
const SKILL_FIXTURE = `---\nname: feature-dev\ndescription: "功能开发流程"\nagentTypes: [feature]\ntriggers: [登录, 认证, 会话, 鉴权, 令牌]\nstatus: published\n---\n\n${SKILL_BODY}\n`;
function writeSkillFixture() {
  fs.mkdirSync(path.join(testSkillsDir, 'feature-dev'), { recursive: true });
  fs.writeFileSync(path.join(testSkillsDir, 'feature-dev', 'SKILL.md'), SKILL_FIXTURE, 'utf-8');
}
writeSkillFixture();

const { mockExecSync, mockExecuteLightweight, mockInjectContext } = vi.hoisted(() => ({
  mockExecSync: vi.fn().mockReturnValue('Claude Code CLI version 1.0.0'),
  mockExecuteLightweight: vi.fn(),
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../workunit/workunit.service', () => ({
  WorkUnitService: vi.fn().mockImplementation(function () { return {
    claim: vi.fn(),
    unclaim: vi.fn(),
    transitionStatus: vi.fn(),
  }; }),
  snapshotToData: (s: unknown) => s,
}));

vi.mock('../../triggers/trigger-registry', () => ({
  getTriggerScheduler: () => ({
    registerTrigger: vi.fn(),
    unregisterTrigger: vi.fn(),
    registerExecuteHandler: vi.fn(),
    getStates: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: mockInjectContext,
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
  INJECT_TOKEN_BUDGET: 2000,
}));

import { FileStore, estimateTokens } from '@dommaker/studio-shared';

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载
const { AgentLoop } = await import('../loop/agent-loop');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

/** 新注入契约的固定文本（与 agent-loop buildSkillSection 保持一致） */
const SKILL_HEADER = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
const SKILL_BLOCK = `### feature-dev\n功能开发流程｜触发：登录, 认证, 会话, 鉴权, 令牌\n全文：${path.join(os.homedir(), '.studio', 'skills', 'feature-dev', 'SKILL.md')}`;
const SKILL_MANIFEST_POINTER = `完整 skill 清单见 skills MANIFEST.md（${path.join(os.homedir(), '.studio', 'skills', 'MANIFEST.md')}）`;
const SKILL_TOKENS = estimateTokens(SKILL_HEADER.length) + estimateTokens(SKILL_BLOCK.length + 2)
  + estimateTokens(SKILL_MANIFEST_POINTER.length + 2);

describe('§10 P0 + 决策 7/11/13: agentStep skill/persona 注入', () => {
  let agentLoop: AgentLoop;
  let testDir: string;
  let fileStore: FileStore;

  // description/persona 均为空 —— 默认不产 persona 段（各用例按需覆盖）
  const mockRole = {
    id: 'role-1',
    name: 'test-agent',
    description: null,
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const makeWu = (metadata: string | null, overrides: Record<string, unknown> = {}) => ({
    id: 'wu-1', type: 'feature', scope: '实现登录功能', channelId: 'ch-1',
    status: 'active', assigneeId: 'agent-1', parentId: null,
    failureType: null, retryCount: 0, timeoutAt: null,
    projectPath: null, metadata, claimedAt: null,
    completedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('Claude Code CLI version 1.0.0');
    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:working',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    testDir = path.join(os.tmpdir(), `agent-loop-skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fileStore = new FileStore(testDir);
  });

  afterEach(async () => {
    if (agentLoop) {
      agentLoop.stop();
      await Promise.race([
        agentLoop.waitForStop(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 5000);

  async function runStep(wu: ReturnType<typeof makeWu>, roleOverrides: Record<string, unknown> = {}) {
    agentLoop = new AgentLoop({ ...mockRole, ...roleOverrides } as any, fileStore);
    await agentLoop.start();
    const result = await (agentLoop as unknown as {
      agentStep(t: unknown): Promise<{ metadataUpdates?: { matchedSkills?: string[] } }>;
    }).agentStep({ workUnit: wu });
    const task = mockExecuteLightweight.mock.calls[0][0];
    return { knowledgeContext: task.parameters.knowledgeContext as string, result };
  }

  it('域匹配命中（wuType feature→implement ∩ agentTypes [feature]）→ 索引段在 `## 项目上下文` 之前，含协议行不含正文', async () => {
    const { knowledgeContext } = await runStep(makeWu(null));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(knowledgeContext).toContain('以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。');
    expect(knowledgeContext).toContain('### feature-dev');
    expect(knowledgeContext).toContain('功能开发流程｜触发：登录, 认证, 会话, 鉴权, 令牌');
    expect(knowledgeContext).toContain(`全文：${path.join(os.homedir(), '.studio', 'skills', 'feature-dev', 'SKILL.md')}`);
    expect(knowledgeContext).not.toContain(SKILL_BODY);
    expect(knowledgeContext).toContain('## 项目上下文');
    expect(knowledgeContext).toContain('- test rule');
    expect(knowledgeContext.indexOf('## 本次任务 Skills')).toBeLessThan(knowledgeContext.indexOf('## 项目上下文'));

    // skill 段先占定额：injectContext 收到 knowledge 定额 1000 + 各前段余量（map/persona/roster/memory 空）
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 1000 + (1400 - SKILL_TOKENS) + 300 + 400 + 300,
    });
  });

  it('匹配名单经 metadataUpdates.matchedSkills 返回（随 recordResult 原子落盘，供度量/被无视率）', async () => {
    const { result } = await runStep(makeWu(null));

    expect(result.metadataUpdates?.matchedSkills).toEqual(['feature-dev']);
  });

  it('metadata.matchedSkills 不再作为注入输入：陈旧值被忽略，以 step 时实时匹配为准', async () => {
    // 陈旧 metadata 指向不存在的 skill —— 旧实现读它注入，新实现 step 时重算
    const { knowledgeContext } = await runStep(makeWu(JSON.stringify({ matchedSkills: ['no-such-skill'] })));

    expect(knowledgeContext).toContain('### feature-dev');
    expect(knowledgeContext).not.toContain('no-such-skill');
  });

  it('决策 11：+skill 从 scope 解析并入最高优先级（无域/文本交集也命中）', async () => {
    // scope 与 skill 描述零文本交集、type 无域交集 —— 只能靠 +显式点名
    const wu = makeWu(null, { type: 'zzz-无交集', scope: 'xyzzy 无交集 +feature-dev' });
    const { knowledgeContext, result } = await runStep(wu);

    expect(knowledgeContext).toContain('### feature-dev');
    expect(result.metadataUpdates?.matchedSkills?.[0]).toBe('feature-dev');
  });

  it('skill 库为空 → 无 skill 段，injectContext 吃到全部前段余量（#91：1000 定额 + 2400 余量）', async () => {
    fs.rmSync(path.join(testSkillsDir, 'feature-dev'), { recursive: true, force: true });
    invalidateManifestCache();
    try {
      const { knowledgeContext } = await runStep(makeWu(null));

      expect(knowledgeContext).toBe('## 系统约束\n- test rule');
      expect(knowledgeContext).not.toContain('## 本次任务 Skills');
      expect(mockInjectContext).toHaveBeenCalledWith('feature', {
        tags: ['feature'],
        maxTokens: 1000 + 800 + 600 + 300 + 400 + 300,
      });
    } finally {
      writeSkillFixture();
      invalidateManifestCache();
    }
  });

  it('决策 13：role.persona → 注入 `## 你的角色` 段，顺序在 skills 之前（#119 段序重排）、知识之前', async () => {
    const { knowledgeContext } = await runStep(makeWu(null), { persona: '你是测试者，先写测试再实现。' });

    expect(knowledgeContext).toContain('## 你的角色\n\n你是测试者，先写测试再实现。');
    expect(knowledgeContext.indexOf('## 你的角色')).toBeLessThan(knowledgeContext.indexOf('## 本次任务 Skills'));
    expect(knowledgeContext.indexOf('## 本次任务 Skills')).toBeLessThan(knowledgeContext.indexOf('## 项目上下文'));
  });

  it('决策 13：persona 缺省回退 description', async () => {
    const { knowledgeContext } = await runStep(makeWu(null), { description: '只是角色描述' });

    expect(knowledgeContext).toContain('## 你的角色\n\n只是角色描述');
  });

  it('决策 13：persona/description 皆空 → `## 你的角色` 段省略', async () => {
    const { knowledgeContext } = await runStep(makeWu(null));

    expect(knowledgeContext).not.toContain('## 你的角色');
  });

  it('决策 13 + #91/#119：注入顺序 persona > roster > skills > knowledge（#119 段序稳定性重排）', async () => {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-1', name: '#test-order', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(['p-other']),
      createdAt: now, updatedAt: now,
    });
    await fileStore.createProfile({
      id: 'p-other', name: 'other-agent', description: '其他成员',
      channels: '[]', status: 'active', createdAt: now, updatedAt: now,
    });

    const { knowledgeContext } = await runStep(makeWu(null), { persona: '你是排序验证者。' });

    const skillIdx = knowledgeContext.indexOf('## 本次任务 Skills');
    const personaIdx = knowledgeContext.indexOf('## 你的角色');
    const rosterIdx = knowledgeContext.indexOf('## 频道成员与委派');
    const knowledgeIdx = knowledgeContext.indexOf('## 项目上下文');
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(rosterIdx).toBeGreaterThan(personaIdx);
    expect(skillIdx).toBeGreaterThan(rosterIdx);
    expect(knowledgeIdx).toBeGreaterThan(skillIdx);
  });
});
