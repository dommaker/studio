/**
 * B3a 工程归属链（决策 D2）— waiting-input 回复解析绑定测试
 *
 * 覆盖：
 * - 唯一命中 → 绑定 metadata.workspaceRoot + 复活（blocked → active）+ 写回 Requirement.projectId
 * - 已有 gitRepo 相同的 PMO 项目 → 复用（不新建）
 * - 多候选 → 继续等待 + 频道列候选
 * - 无命中 → 继续等待 + 列出全部可选工程
 * - 非 ownership 挂起的回复不受影响（走原 F5 路径）
 *
 * 约定：discovery 根用 STUDIO_PROJECTS_ROOT 指向 tmp fixture；
 * PMO 项目写真实 ~/.studio/projects（workspace-binding.test.ts 同款约定），afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';
import { resumeWaitingWorkUnit } from '../waiting-input.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { projectService } from '../../pmo/project.service.js';

let tmpDir: string;
let discoveryRoot: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let reqService: RequirementService;
let channelId: string;
let savedProjectsRoot: string | undefined;
const createdProjectIds: string[] = [];

function metaOf(snapshot: { metadata: string | null }): WorkUnitMetadata {
  return snapshot.metadata ? JSON.parse(snapshot.metadata) : {};
}

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id)!;
}

/** 在 discovery fixture 下造一个假工程（package.json 标记） */
function makeDiscoveredProject(name: string): string {
  const dir = path.join(discoveryRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  return dir;
}

/** 造一个等待工程归属的挂起 WU（blocked + waitingReason='ownership'）及 anchor 消息 */
async function createOwnershipParkedWu(reqId?: string) {
  const wu = await wuService.create({
    scope: '改一下登录页',
    channelId,
    type: 'task',
    status: 'blocked',
    assigneeId: 'instance-1',
    reqId: reqId ?? null,
    metadata: {
      waitingForInput: true,
      waitingQuestion: '这个任务要修改哪个工程？请回复工程名或路径',
      waitingSince: new Date().toISOString(),
      waitingReason: 'ownership',
      ownershipSource: 'none',
    },
  });
  const anchor: ChannelMessageData = {
    id: uuidv4(), channelId, authorType: 'human', agentName: null,
    content: '@Agent 改一下登录页', replyToId: null, meta: '{}',
    workUnitId: wu.id, createdAt: new Date().toISOString(),
  };
  await fileStore.appendMessage(channelId, anchor);
  return { wu, anchor };
}

async function createRealProject(gitRepo: string) {
  const project = await projectService.create({
    title: `b3a-waiting-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    gitRepo,
  });
  createdProjectIds.push(project.id);
  return project;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-ownership-test-'));
  discoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-ownership-projects-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  reqService = new RequirementService(fileStore);
  channelId = `ch-waiting-b3a-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#waiting-b3a', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  savedProjectsRoot = process.env.STUDIO_PROJECTS_ROOT;
  process.env.STUDIO_PROJECTS_ROOT = discoveryRoot;
});

afterEach(async () => {
  if (savedProjectsRoot === undefined) {
    delete process.env.STUDIO_PROJECTS_ROOT;
  } else {
    process.env.STUDIO_PROJECTS_ROOT = savedProjectsRoot;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(discoveryRoot, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.delete(id).catch(() => { /* 已删除/状态不可删时忽略 */ });
  }
  // 回复绑定可能新建 PMO 项目 —— 经 Requirement 反查清理
  // （各用例在断言时记录 createdProjectIds；此处兜底）
});

describe('B3a: 回复解析绑定工程（唯一命中）', () => {
  it('唯一命中 → 绑定 workspaceRoot + 复活 + 写回 Requirement.projectId（新建 PMO 项目）', async () => {
    const repoDir = makeDiscoveredProject('alpha');
    const req = await reqService.create({ title: '归属需求', channelId });
    const { wu } = await createOwnershipParkedWu(req.id);

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('active');
    const meta = metaOf(after);
    expect(meta.waitingForInput).toBe(false);
    expect(meta.workspaceRoot).toBe(repoDir);
    expect(meta.ownershipSource).toBe('human-reply');
    expect(meta.pendingReplies).toEqual(['alpha']);

    // Requirement.projectId 已写回，指向 gitRepo 锚定该路径的 PMO 项目
    const updatedReq = await reqService.get(req.id);
    expect(updatedReq!.projectId).toBeTruthy();
    createdProjectIds.push(updatedReq!.projectId!);
    const project = await projectService.get(updatedReq!.projectId!);
    expect(project!.gitRepo).toBe(repoDir);
  });

  it('已有 gitRepo 相同的 PMO 项目 → 复用（不新建）', async () => {
    const repoDir = makeDiscoveredProject('alpha');
    const existing = await createRealProject(repoDir);
    const req = await reqService.create({ title: '归属需求', channelId });
    const { wu } = await createOwnershipParkedWu(req.id);

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);

    expect(resumed).toBe(true);
    const updatedReq = await reqService.get(req.id);
    expect(updatedReq!.projectId).toBe(existing.id);
  });

  it('Requirement 已有 projectId → 不覆盖', async () => {
    const repoDir = makeDiscoveredProject('alpha');
    const preset = await createRealProject('/data/preset-repo');
    const req = await reqService.create({ title: '归属需求', channelId, projectId: preset.id });
    const { wu } = await createOwnershipParkedWu(req.id);

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(repoDir); // WU 仍按回复绑定
    expect((await reqService.get(req.id))!.projectId).toBe(preset.id); // 需求归属不动
  });

  it('WU 无 reqId → 正常绑定复活，不写回（不报错）', async () => {
    const repoDir = makeDiscoveredProject('alpha');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(repoDir);
  });
});

describe('B3a: 回复解析未命中 → 继续等待并列候选', () => {
  it('多候选 → 保持挂起，频道消息列出候选', async () => {
    makeDiscoveredProject('beta-one');
    makeDiscoveredProject('beta-two');
    const { wu, anchor } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'beta', fileStore);

    expect(resumed).toBe(false);
    const after = await findWu(wu.id);
    expect(after.status).toBe('blocked');
    expect(metaOf(after).waitingForInput).toBe(true);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.agentName === 'Studio');
    expect(notice).toBeTruthy();
    expect(notice!.content).toContain('匹配到多个工程');
    expect(notice!.content).toContain('beta-one');
    expect(notice!.content).toContain('beta-two');
    expect(notice!.replyToId).toBe(anchor.id);
  });

  it('无命中 → 保持挂起，频道消息列出全部可选工程', async () => {
    makeDiscoveredProject('gamma');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'zzz-no-match', fileStore);

    expect(resumed).toBe(false);
    expect((await findWu(wu.id)).status).toBe('blocked');

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.agentName === 'Studio');
    expect(notice).toBeTruthy();
    expect(notice!.content).toContain('没有找到匹配');
    expect(notice!.content).toContain('gamma');
  });

  it('多候选后人再回复唯一名 → 绑定复活', async () => {
    const repoOne = makeDiscoveredProject('beta-one');
    makeDiscoveredProject('beta-two');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, 'beta', fileStore)).toBe(false);
    const resumed = await resumeWaitingWorkUnit(wu.id, 'beta-one', fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(repoOne);
  });
});

describe('B3a: 非 ownership 挂起不受影响', () => {
  it('agent 提问型挂起 → 回复直接复活（不触发工程解析）', async () => {
    makeDiscoveredProject('alpha');
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task', status: 'blocked', assigneeId: 'instance-1',
      metadata: {
        waitingForInput: true,
        waitingQuestion: '使用 OAuth 还是账号密码？',
        waitingSince: new Date().toISOString(),
      },
    });

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);

    expect(resumed).toBe(true);
    const meta = metaOf(await findWu(wu.id));
    expect(meta.workspaceRoot).toBeUndefined(); // 不做工程绑定
    expect(meta.pendingReplies).toEqual(['alpha']);
  });
});
