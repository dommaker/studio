// A2A P1 集成测试：recordResult DELEGATE 分支 / 父 complete 守卫 / §4.2 发言层新鲜度检查 / 花名册注入
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService + DelegationGate；
// git 调用、workspace 解析、CLI 执行、knowledge 注入 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, stringifyChannels, type ChannelMessageData, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));
vi.mock('child_process', () => ({ execSync: mockExecSync }));

const { mockResolveWorkspaceRoot } = vi.hoisted(() => ({ mockResolveWorkspaceRoot: vi.fn() }));
vi.mock('../../workspaces/workspace-store', () => ({ resolveWorkspaceRoot: mockResolveWorkspaceRoot }));

const { mockExecuteLightweight } = vi.hoisted(() => ({ mockExecuteLightweight: vi.fn() }));
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { executeLightweight: mockExecuteLightweight },
}));

const { mockInjectContext } = vi.hoisted(() => ({ mockInjectContext: vi.fn() }));
vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: mockInjectContext,
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop, parseAgentOutput } from '../agent-loop';

function makeProfile(id: string, name: string): AgentProfileData {
  return {
    id, name, description: `${name} 的描述`, channels: '[]', status: 'active',
    provider: 'claude', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

const profileA = makeProfile('profile-a', 'AgentA');
const profileB = makeProfile('profile-b', 'AgentB');
const profileC = makeProfile('profile-c', 'AgentC');

const roleA = {
  id: profileA.id,
  name: profileA.name,
  description: profileA.description,
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface LoopInternals {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; channelVersion?: { lineCount: number; lastMessageId: string | null } }>;
}

describe('A2A P1: DELEGATE / complete 守卫 / 新鲜度检查 / 花名册', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;
  let loop: LoopInternals;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-a2a-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-a2a-${Date.now()}`;
    for (const p of [profileA, profileB, profileC]) {
      await fileStore.createProfile(p);
    }
    await fileStore.createChannel({
      id: channelId, name: '#a2a-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: stringifyChannels([profileA.id, profileB.id, profileC.id]),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 不 start()：recordResult/agentStep 不依赖运行中的 loop 实例
    agentLoop = new AgentLoop(roleA, fileStore);
    loop = agentLoop as unknown as LoopInternals;
    mockResolveWorkspaceRoot.mockResolvedValue(null); // 跳过提交守卫（无关本测试关注点）
    mockInjectContext.mockResolvedValue({ prompt: '', injectedIds: [] });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 创建 active 父 WU（A 已 claim）+ anchor 消息 */
  async function setupParent(metadata?: WorkUnitMetadata) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-a',
      workspaceId: 'ws-1', reqId: 'REQ-0001',
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@AgentA 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return (await wuService.getById(wu.id))!;
  }

  async function metaOf(wuId: string): Promise<WorkUnitMetadata> {
    const wu = (await wuService.getById(wuId))!;
    return JSON.parse(wu.metadata!);
  }

  async function channelMessages(): Promise<ChannelMessageData[]> {
    return fileStore.queryMessages(channelId);
  }

  describe('parseAgentOutput DELEGATE 协议（§4.1 机制 1）', () => {
    it('解析 ACTION: DELEGATE:@<name>:<scope>', () => {
      const result = parseAgentOutput('做了一些分析\nACTION: DELEGATE:@AgentB:审查登录模块的实现');
      expect(result.action).toBe('delegate');
      expect(result.delegate).toEqual({ targetName: 'AgentB', scope: '审查登录模块的实现' });
      expect(result.summary).toBe('审查登录模块的实现');
    });

    it('scope 为空 → 解析失败按 progress 容错', () => {
      const result = parseAgentOutput('ACTION: DELEGATE:@AgentB:');
      expect(result.action).toBe('progress');
    });

    it('格式不对（缺 scope 段）→ progress 容错', () => {
      const result = parseAgentOutput('ACTION: DELEGATE:@AgentB');
      expect(result.action).toBe('progress');
    });

    it('多 ACTION 行取最后一行', () => {
      const result = parseAgentOutput('ACTION: PROGRESS:先做一点\nACTION: DELEGATE:@AgentB:复核');
      expect(result.action).toBe('delegate');
      expect(result.delegate?.targetName).toBe('AgentB');
    });
  });

  describe('recordResult DELEGATE 分支（§4.1 机制 3-5）', () => {
    it('闸门通过 → 建子单 + collab 元数据 + delegate 卡片 + 父按 progress 继续', async () => {
      const parent = await setupParent();
      await loop.recordResult({ workUnit: parent }, {
        action: 'delegate', summary: '审查登录模块的实现',
        delegate: { targetName: 'AgentB', scope: '审查登录模块的实现' },
      });

      // 父 WU：状态不变（active），collab 补记为根记录且 delegationCount=1
      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('active');
      const parentMeta = JSON.parse(after.metadata!) as WorkUnitMetadata;
      expect(parentMeta.collab).toEqual({
        rootId: parent.id, depth: 0, chain: [profileA.id], delegationCount: 1,
      });

      // 子 WU：parentId/assigneeId=profileId/继承 channelId+reqId+workspaceId/unassigned/collab
      const children = (await wuService.list({ parentId: parent.id })).data;
      expect(children).toHaveLength(1);
      const child = children[0];
      expect(child.assigneeId).toBe(profileB.id);
      expect(child.status).toBe('unassigned');
      expect(child.channelId).toBe(channelId);
      expect(child.reqId).toBe('REQ-0001');
      expect(child.workspaceId).toBe('ws-1');
      expect(child.scope).toBe('审查登录模块的实现');
      const childMeta = JSON.parse(child.metadata!) as WorkUnitMetadata;
      expect(childMeta.creationMode).toBe('agent-delegate');
      expect(childMeta.collab).toEqual({
        rootId: parent.id,
        depth: 1,
        chain: [profileA.id, profileB.id],
        delegatedBy: { profileId: profileA.id, workUnitId: parent.id },
        delegationCount: 0,
      });

      // delegate 卡片：@A 委派 @B：<scope>（深度 1/1），authorType=agent
      const cards = (await channelMessages()).filter(m => m.authorType === 'agent');
      expect(cards).toHaveLength(1);
      expect(cards[0].content).toBe(`@AgentA 委派 @AgentB：审查登录模块的实现（深度 1/1）`);
      expect(cards[0].workUnitId).toBe(parent.id);
    });

    it('再次委派不同目标 → delegationCount 累加为 2', async () => {
      const parent = await setupParent();
      const delegate = (targetName: string) => loop.recordResult({ workUnit: parent }, {
        action: 'delegate', summary: '分工', delegate: { targetName, scope: '分工' },
      });
      await delegate('AgentB');
      await delegate('AgentC');

      const parentMeta = await metaOf(parent.id);
      expect(parentMeta.collab?.delegationCount).toBe(2);
      expect((await wuService.list({ parentId: parent.id })).data).toHaveLength(2);
    });

    it('闸门拒绝（目标不存在）→ 按 NEED_INPUT 处理：blocked + 挂起标记 + 原因卡片', async () => {
      const parent = await setupParent();
      await loop.recordResult({ workUnit: parent }, {
        action: 'delegate', summary: '审查实现',
        delegate: { targetName: 'NoAgent', scope: '审查实现' },
      });

      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('blocked');
      const meta = JSON.parse(after.metadata!) as WorkUnitMetadata;
      expect(meta.waitingForInput).toBe(true);
      expect(meta.waitingQuestion).toContain('拟委派 @NoAgent：审查实现，因');
      expect(meta.waitingQuestion).toContain('需人工确认');
      expect(meta.collab).toBeUndefined();

      const cards = (await channelMessages()).filter(m => m.authorType === 'agent');
      expect(cards).toHaveLength(1);
      expect(cards[0].content).toContain('需要输入: 拟委派 @NoAgent：审查实现，因');
      expect(cards[0].content).toContain('需人工确认');
      expect((await wuService.list({ parentId: parent.id })).data).toHaveLength(0);
    });

    it('闸门拒绝（重复委派同一目标）→ blocked，不重复建单', async () => {
      const parent = await setupParent();
      const delegateB = () => loop.recordResult({ workUnit: parent }, {
        action: 'delegate', summary: '审查实现',
        delegate: { targetName: 'AgentB', scope: '审查实现' },
      });
      await delegateB();
      // 第一次委派后父仍 active；恢复 active 再试第二次（blocked 是第二次的结果）
      await delegateB();

      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('blocked');
      expect((await metaOf(parent.id)).waitingQuestion).toContain('未完结子任务');
      expect((await wuService.list({ parentId: parent.id })).data).toHaveLength(1);
    });
  });

  describe('父 complete 守卫（§6-2）', () => {
    it('存在未完结子 WU → COMPLETE 降级 progress，提示列子任务 id', async () => {
      const parent = await setupParent();
      const child = await wuService.create({
        scope: '子任务', channelId, type: 'task', status: 'unassigned', parentId: parent.id,
      });

      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了' });

      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('active');
      const meta = JSON.parse(after.metadata!) as WorkUnitMetadata;
      expect(meta.childGuardHint).toContain(child.id);
      // 摘要仍按 progress 发到频道
      const messages = await channelMessages();
      expect(messages.some(m => m.authorType === 'agent' && m.content.includes('做完了'))).toBe(true);
    });

    it('子 WU 全部 done/closed → 正常进入 in_review', async () => {
      const parent = await setupParent();
      await wuService.create({ scope: '子1', channelId, type: 'task', status: 'done', parentId: parent.id });
      await wuService.create({ scope: '子2', channelId, type: 'task', status: 'closed', parentId: parent.id });

      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了' });

      expect((await wuService.getById(parent.id))!.status).toBe('in_review');
      expect((await metaOf(parent.id)).childGuardHint).toBeUndefined();
    });

    it('无子 WU → 守卫不触发', async () => {
      const parent = await setupParent();
      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了' });
      expect((await wuService.getById(parent.id))!.status).toBe('in_review');
    });
  });

  describe('发言层新鲜度检查（§4.2）', () => {
    /** mid-step 新消息（人类） */
    async function appendHuman(content: string, wuId: string) {
      const msg: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content, replyToId: null, meta: '{}', workUnitId: wuId,
        createdAt: new Date().toISOString(),
      };
      await fileStore.appendMessage(channelId, msg);
    }

    it('step 期间房间有新消息 → 结果不发帖，注入 pendingReplies，计 1 次拦截', async () => {
      const parent = await setupParent();
      const v0 = await fileStore.getChannelVersion(channelId);
      await appendHuman('等一下，需求变了', parent.id);

      await loop.recordResult({ workUnit: parent }, {
        action: 'complete', summary: '做完了', channelVersion: v0,
      });

      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('active'); // 按 progress 处理，未进 in_review
      const meta = JSON.parse(after.metadata!) as WorkUnitMetadata;
      expect(meta.freshnessInterrupts).toBe(1);
      expect(meta.pendingReplies).toEqual(['等一下，需求变了']);
      const messages = await channelMessages();
      expect(messages.some(m => m.content.includes('做完了'))).toBe(false);
    });

    it('连续 2 次拦截后第 3 次照发并注明「发送时房间有新消息」，计数归零', async () => {
      const parent = await setupParent();

      // 第 1 次拦截
      let version = await fileStore.getChannelVersion(channelId);
      await appendHuman('新消息 1', parent.id);
      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了', channelVersion: version });
      expect((await metaOf(parent.id)).freshnessInterrupts).toBe(1);

      // 第 2 次拦截
      version = await fileStore.getChannelVersion(channelId);
      await appendHuman('新消息 2', parent.id);
      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了', channelVersion: version });
      expect((await metaOf(parent.id)).freshnessInterrupts).toBe(2);
      expect((await wuService.getById(parent.id))!.status).toBe('active');

      // 第 3 次：照发 + 注明 + 归零 + 正常状态迁移
      version = await fileStore.getChannelVersion(channelId);
      await appendHuman('新消息 3', parent.id);
      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了', channelVersion: version });
      expect((await wuService.getById(parent.id))!.status).toBe('in_review');
      expect((await metaOf(parent.id)).freshnessInterrupts).toBe(0);
      const messages = await channelMessages();
      expect(messages.some(m =>
        m.authorType === 'agent' && m.content.includes('做完了') && m.content.includes('（发送时房间有新消息）')
      )).toBe(true);
    });

    it('房间无变化 → 正常发帖；本 agent 自己的消息不算「房间已变」', async () => {
      const parent = await setupParent();
      const v0 = await fileStore.getChannelVersion(channelId);
      // 本 loop 自己的 agent 消息（如 delegate 卡片）不触发拦截
      const own: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'agent', agentName: 'AgentA',
        content: '@AgentA 委派 @AgentB：分工（深度 1/1）', replyToId: null, meta: '{}',
        workUnitId: parent.id, createdAt: new Date().toISOString(),
      };
      await fileStore.appendMessage(channelId, own);

      await loop.recordResult({ workUnit: parent }, { action: 'complete', summary: '做完了', channelVersion: v0 });

      expect((await wuService.getById(parent.id))!.status).toBe('in_review');
      const messages = await channelMessages();
      expect(messages.some(m => m.authorType === 'agent' && m.content === '做完了')).toBe(true);
    });

    it('无 channelVersion（无频道/读取失败）→ 跳过检查直接发帖', async () => {
      const parent = await setupParent();
      await loop.recordResult({ workUnit: parent }, { action: 'progress', summary: '推进中' });
      const messages = await channelMessages();
      expect(messages.some(m => m.authorType === 'agent' && m.content === '推进中')).toBe(true);
    });
  });

  describe('成员花名册注入（§4.1 机制 2）', () => {
    async function runStep(wuId: string) {
      mockExecuteLightweight.mockResolvedValue({
        success: true, outputText: 'ACTION: PROGRESS:继续',
        logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
      });
      const wu = (await wuService.getById(wuId))!;
      return loop.agentStep({ workUnit: wu });
    }

    it('knowledgeContext 含花名册段（其他成员 name+description+provider），排除自己', async () => {
      const parent = await setupParent();
      await runStep(parent.id);

      const task = mockExecuteLightweight.mock.calls[0][0];
      const ctx = task.parameters.knowledgeContext as string;
      expect(ctx).toContain('## 频道成员与委派');
      expect(ctx).toContain('AgentB');
      expect(ctx).toContain('AgentB 的描述');
      expect(ctx).toContain('provider: claude');
      expect(ctx).toContain('ACTION: DELEGATE:@');
      expect(ctx).not.toContain('AgentA（provider');
    });

    it('花名册占用 2K 预算：injectContext 的 maxTokens 相应缩减（skills > roster > knowledge）', async () => {
      const parent = await setupParent();
      await runStep(parent.id);

      const opts = mockInjectContext.mock.calls[0][1];
      expect(opts.maxTokens).toBeLessThan(2000);
      expect(opts.maxTokens).toBeGreaterThan(0);
    });

    it('members 为空 → 回退到全部 active profile（与闸门口径一致）', async () => {
      await fileStore.updateChannel(channelId, { members: '[]' });
      const parent = await setupParent();
      await runStep(parent.id);

      const ctx = mockExecuteLightweight.mock.calls[0][0].parameters.knowledgeContext as string;
      expect(ctx).toContain('## 频道成员与委派');
      expect(ctx).toContain('AgentB');
    });

    it('无频道 → 无花名册段', async () => {
      const wu = await wuService.create({ scope: '离线任务', type: 'task', status: 'active', assigneeId: 'instance-a' });
      await runStep(wu.id);

      const ctx = mockExecuteLightweight.mock.calls[0][0].parameters.knowledgeContext;
      expect(ctx ?? '').not.toContain('## 频道成员与委派');
    });
  });
});
