/**
 * B3a 工程归属链（决策 D2）— message-routing 接线测试
 *
 * 覆盖：
 * - 无归属（无显式/REQ 无 projectId/频道无默认）→ WU 照常创建但立即 NEED_INPUT
 *   挂起（blocked + waitingForInput + waitingReason='ownership'）+ Studio 系统消息提问
 * - Requirement.projectId → PMO gitRepo → metadata.workspaceRoot 落档（source=requirement）
 * - 显式 workspaceId > Requirement > 频道默认（source 区分）
 * - 有归属时保持旧行为：status=unassigned，无挂起 metadata
 *
 * 约定：PMO 项目写真实 ~/.studio/projects（workspace-binding.test.ts 同款约定），
 * afterEach 清理；discovery 不需要（本文件不触发回复解析）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { projectService, type ProjectData } from '../../pmo/project.service.js';

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
let channelSeq = 0;
const createdProjectIds: string[] = [];

async function createChannel(defaultWorkspaceId: string | null): Promise<string> {
  const id = `ch-b3a-${Date.now()}-${channelSeq++}`;
  await fileStore.createChannel({
    id, name: `#b3a-${id.slice(-6)}`, type: 'rnd',
    defaultWorkspaceId, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return id;
}

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

function metaOf(snapshot: { metadata: string | null }) {
  return snapshot.metadata ? JSON.parse(snapshot.metadata) : {};
}

/** 建真实 PMO 项目（afterEach 统一删除） */
async function createRealProject(gitRepo: string | null): Promise<ProjectData> {
  const project = await projectService.create({
    title: `b3a-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    gitRepo: gitRepo ?? undefined,
  });
  createdProjectIds.push(project.id);
  return project;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-ownership-test-'));
  fileStore = new FileStore(tmpDir);
  reqService = new RequirementService(fileStore);
  channelMessageService.setFileStore(fileStore);
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const id of createdProjectIds.splice(0)) {
    await projectService.delete(id).catch(() => { /* 已删除/状态不可删时忽略 */ });
  }
});

describe('B3a: 无归属 → NEED_INPUT 挂起问人', () => {
  it('WU 照常创建但立即挂起（blocked + waitingForInput），metadata 落来源与问题', async () => {
    const channelId = await createChannel(null);

    const msg = await routeMessage(channelId, '@Agent 改一下登录页', undefined, fileStore);

    const wu = await findWu(msg.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.status).toBe('blocked');
    expect(wu!.workspaceId ?? null).toBeNull();
    const meta = metaOf(wu!);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.waitingReason).toBe('ownership');
    expect(meta.waitingQuestion).toBe('这个任务要修改哪个工程？请回复工程名或路径');
    expect(meta.waitingSince).toBeTruthy();
    expect(meta.ownershipSource).toBe('none');
    expect(meta.workspaceRoot).toBeUndefined();
  });

  it('向频道发 Studio 系统消息提问（挂在派发消息线程）', async () => {
    const channelId = await createChannel(null);

    const msg = await routeMessage(channelId, '@Agent 改一下登录页', undefined, fileStore);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: msg.workUnitId! });
    const prompt = messages.find(m => m.agentName === 'Studio');
    expect(prompt).toBeTruthy();
    expect(prompt!.authorType).toBe('agent');
    expect(prompt!.content).toContain('这个任务要修改哪个工程？请回复工程名或路径');
    expect(prompt!.content).toContain('改一下登录页');
    expect(prompt!.replyToId).toBe(msg.id); // 挂在派发消息线程
  });

  it('REQ 绑定失败（reqId=null）同样挂起，不阻断建 WU', async () => {
    const channelId = await createChannel(null);
    // 制造 REQ 存储故障：requirements 路径被同名文件占用
    fs.writeFileSync(path.join(tmpDir, 'requirements'), 'block-dir', 'utf-8');

    const msg = await routeMessage(channelId, '@Agent 容错任务', undefined, fileStore);

    const wu = await findWu(msg.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.reqId ?? null).toBeNull();
    expect(wu!.status).toBe('blocked');
    expect(metaOf(wu!).waitingReason).toBe('ownership');
  });
});

describe('B3a: 归属解析优先级接线', () => {
  it('Requirement.projectId → PMO gitRepo：metadata.workspaceRoot 落档，status=unassigned', async () => {
    const channelId = await createChannel('ws-channel-default');
    const project = await createRealProject('/data/b3a-repo');
    const req = await reqService.create({ title: '归属需求', channelId, projectId: project.id });

    const msg = await routeMessage(channelId, '@Agent 干活', undefined, fileStore, { reqId: req.id });

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.status).toBe('unassigned'); // 有归属 → 不挂起
    expect(wu!.workspaceId ?? null).toBeNull(); // gitRepo 路径不经 workspace 记录
    const meta = metaOf(wu!);
    expect(meta.ownershipSource).toBe('requirement');
    expect(meta.workspaceRoot).toBe('/data/b3a-repo');
    expect(meta.ownershipProjectId).toBe(project.id);
    expect(meta.waitingForInput).toBeUndefined();
  });

  it('PMO 项目无 gitRepo → 落频道默认（channel-default）', async () => {
    const channelId = await createChannel('ws-channel-default');
    const project = await createRealProject(null);
    const req = await reqService.create({ title: '无 gitRepo 需求', channelId, projectId: project.id });

    const msg = await routeMessage(channelId, '@Agent 干活', undefined, fileStore, { reqId: req.id });

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.status).toBe('unassigned');
    expect(wu!.workspaceId).toBe('ws-channel-default');
    expect(metaOf(wu!).ownershipSource).toBe('channel-default');
  });

  it('显式 workspaceId 压过 Requirement（source=explicit）', async () => {
    const channelId = await createChannel(null);
    const project = await createRealProject('/data/b3a-repo');
    const req = await reqService.create({ title: '归属需求', channelId, projectId: project.id });

    const msg = await routeMessage(channelId, '@Agent 干活', undefined, fileStore, {
      reqId: req.id,
      workspaceId: 'ws-explicit',
    });

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.status).toBe('unassigned');
    expect(wu!.workspaceId).toBe('ws-explicit');
    const meta = metaOf(wu!);
    expect(meta.ownershipSource).toBe('explicit');
    expect(meta.workspaceRoot).toBeUndefined();
  });

  it('频道默认工程 → source=channel-default，不挂起', async () => {
    const channelId = await createChannel('ws-channel-default');

    const msg = await routeMessage(channelId, '@Agent 干活', undefined, fileStore);

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.status).toBe('unassigned');
    expect(wu!.workspaceId).toBe('ws-channel-default');
    const meta = metaOf(wu!);
    expect(meta.ownershipSource).toBe('channel-default');
    expect(meta.waitingForInput).toBeUndefined();
  });
});
