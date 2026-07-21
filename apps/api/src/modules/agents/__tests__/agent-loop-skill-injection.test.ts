/**
 * §10 P0 — agentStep skill 索引注入（index-on-demand）
 *
 * - metadata.matchedSkills 存在：knowledgeContext 含 `## 本次任务 Skills`（在 `## 项目上下文` 之前）
 *   + 每个 skill 的索引块（name + description + `.studio/skills/<name>/SKILL.md` 指针），不含正文；
 *   injectContext 收到扣减后的 maxTokens
 * - 无 matchedSkills：行为与现状一致（无 skill 段，injectContext 默认 2K 预算）
 * - 内存快照缺 matchedSkills：回读 FileStore 索引补一次
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import agent-loop
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-skills-'));
process.env.SKILLS_DIR = testSkillsDir;

const SKILL_BODY = '## 执行步骤\n\n1. 读需求\n2. 写代码\n3. 跑测试';
fs.mkdirSync(path.join(testSkillsDir, 'feature-dev'), { recursive: true });
fs.writeFileSync(
  path.join(testSkillsDir, 'feature-dev', 'SKILL.md'),
  `---\nname: feature-dev\ndescription: "功能开发流程"\nagentTypes: [feature]\nstatus: published\n---\n\n${SKILL_BODY}\n`,
  'utf-8',
);

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
  WorkUnitService: vi.fn().mockImplementation(() => ({
    claim: vi.fn(),
    unclaim: vi.fn(),
    transitionStatus: vi.fn(),
  })),
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
const { AgentLoop } = await import('../agent-loop');

describe('§10 P0: agentStep skill 注入', () => {
  let agentLoop: AgentLoop;
  let testDir: string;
  let fileStore: FileStore;

  const mockRole = {
    id: 'role-1',
    name: 'test-agent',
    description: 'A test agent for unit testing',
    channels: '[]',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const makeWu = (metadata: string | null) => ({
    id: 'wu-1', type: 'feature', scope: '实现登录功能', channelId: 'ch-1',
    status: 'active', assigneeId: 'agent-1', parentId: null,
    failureType: null, retryCount: 0, timeoutAt: null,
    projectPath: null, metadata, claimedAt: null,
    completedAt: null, createdAt: new Date(), updatedAt: new Date(),
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

  async function runStep(wu: ReturnType<typeof makeWu>) {
    agentLoop = new AgentLoop(mockRole as any, fileStore);
    await agentLoop.start();
    await (agentLoop as unknown as { agentStep(t: unknown): Promise<unknown> }).agentStep({ workUnit: wu });
    const task = mockExecuteLightweight.mock.calls[0][0];
    return task.parameters.knowledgeContext as string;
  }

  it('metadata.matchedSkills 存在 → `## 本次任务 Skills` 在 `## 项目上下文` 之前，含索引块不含正文', async () => {
    const knowledgeContext = await runStep(makeWu(JSON.stringify({ matchedSkills: ['feature-dev'] })));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(knowledgeContext).toContain('### feature-dev');
    expect(knowledgeContext).toContain('功能开发流程');
    expect(knowledgeContext).toContain('全文：.studio/skills/feature-dev/SKILL.md（按需阅读）');
    expect(knowledgeContext).not.toContain(SKILL_BODY);
    expect(knowledgeContext).toContain('## 项目上下文');
    expect(knowledgeContext).toContain('- test rule');
    expect(knowledgeContext.indexOf('## 本次任务 Skills')).toBeLessThan(knowledgeContext.indexOf('## 项目上下文'));

    // skill 段优先占预算：injectContext 收到 2000 - skillTokens
    const expectedSection = `## 本次任务 Skills\n\n### feature-dev\n功能开发流程\n全文：.studio/skills/feature-dev/SKILL.md（按需阅读）`;
    const expectedBudget = 2000 - estimateTokens(expectedSection.length);
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: expectedBudget,
    });
  });

  it('无 matchedSkills → 与现状一致（无 skill 段，injectContext 默认 2K）', async () => {
    const knowledgeContext = await runStep(makeWu(null));

    expect(knowledgeContext).toBe('## 系统约束\n- test rule');
    expect(knowledgeContext).not.toContain('## 本次任务 Skills');
    expect(mockInjectContext).toHaveBeenCalledWith('feature', {
      tags: ['feature'],
      maxTokens: 2000,
    });
  });

  it('内存快照缺 matchedSkills → 回读 FileStore 索引补齐', async () => {
    // FileStore 索引里已有 claim 落盘的 matchedSkills，但 agentStep 内存快照（metadata=null）没有
    await fileStore.upsertSnapshot({
      ...makeWu(null),
      metadata: JSON.stringify({ matchedSkills: ['feature-dev'] }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      claimedAt: null, completedAt: null, timeoutAt: null,
    } as any);

    const knowledgeContext = await runStep(makeWu(null));

    expect(knowledgeContext).toContain('## 本次任务 Skills');
    expect(knowledgeContext).toContain('全文：.studio/skills/feature-dev/SKILL.md（按需阅读）');
    expect(knowledgeContext).not.toContain(SKILL_BODY);
  });
});
