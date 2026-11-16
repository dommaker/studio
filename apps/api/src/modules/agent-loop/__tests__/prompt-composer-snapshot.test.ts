/**
 * #671 — prompt-composer 拆分钉线测试：全九段（persona/roster/skills/map/memory/knowledge/files/
 * contract/handoff）+ hint 段全触发的富场景，对 composeStepPrompt 产出（prompt / knowledgeContext /
 * skillMatched / injectedKnowledgeIds / consumedHintUpdates）做整量快照。
 * 用途 = 拆分（纯结构移动）前后产出逐字节等价的对比兜底：快照与拆分同 commit 落盘
 * （生成时序无法从 git 历史独立验证；拆分前等价性已由 #664–#675 批次复审人工逐字节比对确认），
 * 拆分后必须不变。
 * STUDIO_HOME 路径在快照前归一为占位符，避免机器间路径漂移假红。
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SKILLS_DIR 在 manifest-loader 模块加载时读取 —— 必须先设再 import prompt-composer
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-snap-skills-'));
process.env.SKILLS_DIR = testSkillsDir;
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

const { mockInjectContext, mockAppendJsonl, mockProjectGet, mockReadIndex, mockPostWuSystemMessage, mockLogger } = vi.hoisted(() => ({
  mockInjectContext: vi.fn().mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] }),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockProjectGet: vi.fn().mockResolvedValue(null),
  mockReadIndex: vi.fn().mockResolvedValue(''),
  mockPostWuSystemMessage: vi.fn().mockResolvedValue(null),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: { injectContext: mockInjectContext },
  knowledgePorts: { consume: { injectContext: mockInjectContext } },
}));

vi.mock('../agent-loop-events', () => ({
  metricsFileStore: { appendJsonl: mockAppendJsonl },
}));

vi.mock('../../pmo/project.service.js', () => ({
  projectService: { get: mockProjectGet },
}));

vi.mock('../../role-memory/role-memory.js', () => ({
  roleMemoryStore: { readApplicableIndex: mockReadIndex },
}));

vi.mock('../../workunit/wu-messenger.js', () => ({
  postWuSystemMessage: mockPostWuSystemMessage,
}));

import { FileStore } from '@dommaker/studio-shared';
import type { AgentProfileData } from '@dommaker/studio-shared';

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 manifest-loader 模块加载
const { composeStepPrompt } = await import('../prompt-composer');
const { invalidateManifestCache } = await import('../../skills/manifest-loader.js');

// STUDIO_HOME 已被 setup 钉到隔离根；快照前把该根归一为占位符
const studioHome = process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio');
const normalize = (s: string) => s.split(studioHome).join('<STUDIO_HOME>');

describe('#671: composeStepPrompt 全段产出快照（拆分前后逐字节等价钉线）', () => {
  let fileStore: FileStore;
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const entry of fs.readdirSync(testSkillsDir)) {
      fs.rmSync(path.join(testSkillsDir, entry), { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(testSkillsDir, 'tdd-implement'), { recursive: true });
    fs.writeFileSync(
      path.join(testSkillsDir, 'tdd-implement', 'SKILL.md'),
      '---\nname: tdd-implement\ndescription: "测试先行实现"\nagentTypes: [implement]\ntriggers: [登录]\nstatus: published\n---\n\n## 正文\n',
      'utf-8',
    );
    invalidateManifestCache();

    mockInjectContext.mockResolvedValue({ prompt: '## 系统约束\n- test rule', injectedIds: ['rule-1'] });
    mockProjectGet.mockResolvedValue({
      map: {
        destination: '做出多 agent 协作平台',
        decisions: [
          { resolvedAt: '2026-09-30T08:00:00.000Z', summary: '旧决策：先单仓后多仓' },
          { resolvedAt: '2026-10-05T09:00:00.000Z', summary: '新决策：裁决轮一次问齐' },
        ],
        fog: [
          { status: 'open', question: '知识引擎要不要引入向量检索？' },
          { status: 'in-discussion', question: '评审派发走事件还是轮询？' },
          { status: 'resolved', question: '已决问题不列' },
        ],
      },
    });
    mockReadIndex.mockResolvedValue('topics/deploy.md — 部署链踩坑记录\ntopics/review.md — 评审口径沉淀');

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composer-snap-fs-'));
    fileStore = new FileStore(testDir);

    const now = '2026-10-08T00:00:00.000Z';
    await fileStore.createChannel({
      id: 'ch-1', name: '#test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(['p-1', 'p-2']),
      createdAt: now, updatedAt: now,
    } as any);
    await fileStore.createProfile({
      id: 'p-1', name: 'reviewer', description: '评审担当',
      channels: '[]', status: 'active', provider: 'claude',
      createdAt: now, updatedAt: now,
    } as any);
    await fileStore.createProfile({
      id: 'p-2', name: 'dev-helper', description: '开发助手',
      channels: '[]', status: 'active', provider: 'kimi',
      createdAt: now, updatedAt: now,
    } as any);
  });

  afterEach(() => { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }); });

  it('九段 + hint 全触发场景：prompt / knowledgeContext / 附带产出整量快照', async () => {
    const role = {
      id: 'role-1',
      name: 'test-agent',
      description: null,
      persona: '你是资深实现工程师。',
      skills: ['tdd-implement'],
      tools: ['read', 'write'],
      constraints: { can_delegate: true },
      channels: '[]',
      status: 'active',
      provider: 'claude',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    } as unknown as AgentProfileData;

    const wu = {
      id: 'wu-1',
      type: 'implement',
      scope: '实现登录功能',
      channelId: 'ch-1',
    } as any;

    const metadata = {
      pmoId: 'pmo-1',
      stepCount: 2,
      progressLog: [{ step: 1, action: 'PROGRESS', summary: '搭好登录模块骨架' }],
      pendingReplies: ['人类回复：按方案 B 继续'],
      waitingQuestion: '要不要连带改掉旧登录入口？',
      commitGuardHint: '上次 COMPLETE 缺测试被提交守卫打回',
      verifyFailHint: 'pnpm test 红：login.test.ts',
      childGuardHint: '子任务 wu-2 未完结',
      processCheckHint: '上轮未先写测试',
      diffEmptyHint: 'base..HEAD 无提交内容',
      contractArtifactHint: '缺 REVIEW_RESULT 协议行',
      fileRefs: [
        { repo: '/repo/studio', path: 'src/login.ts' },
        { repo: '/repo/other', path: 'docs/auth.md' },
      ],
      workspaceRoot: '/repo/studio',
    } as any;

    const out = await composeStepPrompt(
      { wu, metadata, isNewSession: true },
      {
        role,
        acceptedTypes: ['implement'],
        fileStore,
        resolveEventsFile: () => path.join(testDir, 'studio-events.jsonl'),
      },
    );

    expect({
      prompt: normalize(out.prompt),
      knowledgeContext: normalize(out.knowledgeContext),
      pendingReplies: out.pendingReplies,
      skillMatched: out.skillMatched,
      injectedKnowledgeIds: out.injectedKnowledgeIds,
      consumedHintUpdates: out.consumedHintUpdates,
    }).toMatchSnapshot();
  });
});
