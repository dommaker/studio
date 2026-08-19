/**
 * B3a 工程归属链（决策 D2）— waiting-input 回复解析绑定测试
 *
 * 覆盖：
 * - 唯一命中 → 绑定 metadata.workspaceRoot + 置回 unassigned（保留 assigneeId=profile id，
 *   待指名 loop 认领；WU 创建即挂起从未被认领，置 active 会对所有 loop 不可见而卡死）
 *   + 写回 Requirement.projectId
 * - 已有 gitRepo 相同的 PMO 项目 → 复用（不新建）
 * - 多候选 → 继续等待 + 频道列候选
 * - 无命中 → 继续等待 + 列出全部可选工程
 * - 非 ownership 挂起的回复不受影响（走原 F5 路径，blocked → active）
 *
 * #265（决策 #258）分层匹配 + 绝对路径直连 + 3 轮终止：
 * - 纯函数 matchProjectByReply 分层原语（精确等值 → 尾段边界唯一 → 子串候选）
 * - 回复精确工程名（大小写不敏感）一次解挂；studio 不误命中 studio-config/studio-prod
 * - 尾段边界不唯一 → 落候选列表不误绑
 * - 「/」开头合法工程绝对路径绕过歧义直连绑定；非法路径不绑定
 * - 同一 WU 3 轮未解 → 停止追问 + 播报转人工 + 保持 blocked；之后未解回复不再发声
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
import {
  matchProjectByReply,
  type LocalProject,
} from '../../projects/project-discovery.service.js';
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

/** #265: 造嵌套工程（group/name 两层，group 无标记 → discovery 下钻发现 name） */
function makeNestedProject(group: string, name: string): string {
  const dir = path.join(discoveryRoot, group, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  return dir;
}

/** mention 指名语义：无归属挂起 WU 的 assigneeId 是路由写入的 profile id（非 instance id） */
const MENTIONED_PROFILE_ID = 'profile-dev';
const MENTIONED_INSTANCE_ID = 'instance-dev-1';

/** 造一个等待工程归属的挂起 WU（blocked + waitingReason='ownership'）及 anchor 消息 */
async function createOwnershipParkedWu(reqId?: string) {
  const wu = await wuService.create({
    scope: '改一下登录页',
    channelId,
    type: 'task',
    status: 'blocked',
    assigneeId: MENTIONED_PROFILE_ID,
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
    // 置回 unassigned（非 active）：WU 从未被认领，active + assigneeId=profileId 会对所有 loop 不可见
    expect(after.status).toBe('unassigned');
    // mention 点名语义保留：assigneeId 仍为指名 profile id，等该 profile 的 loop 认领
    expect(after.assigneeId).toBe(MENTIONED_PROFILE_ID);
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

  it('复活后 unassigned + assigneeId=profile id → 可被指名 loop 认领（claim 改写为 instance id）', async () => {
    makeDiscoveredProject('alpha');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'alpha', fileStore);
    expect(resumed).toBe(true);

    // 指名 profile 的 loop 在 unassigned 过滤中看到后认领（agent-loop.ts runLoop 同款路径：
    // 过滤按 role.id 匹配 assigneeId，claim 传入 instance.id）
    const claimed = await wuService.claim(wu.id, MENTIONED_INSTANCE_ID);

    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe(MENTIONED_INSTANCE_ID);
    // 归属回复保留到首次 agentStep 注入（buildReplyPrompt 含 scope + 回复，注入后即清除）
    expect(metaOf(await findWu(wu.id)).pendingReplies).toEqual(['alpha']);
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
    // F5 路径行为不变：WU 已被认领过（assigneeId=instance id），直接回 active 由原 loop 续跑
    expect((await findWu(wu.id)).status).toBe('active');
    const meta = metaOf(await findWu(wu.id));
    expect(meta.workspaceRoot).toBeUndefined(); // 不做工程绑定
    expect(meta.pendingReplies).toEqual(['alpha']);
  });
});

describe('#265: 分层匹配原语 matchProjectByReply（纯函数，无 FileStore）', () => {
  const proj = (p: string): LocalProject => ({ name: p.split('/').pop()!, path: p, hasClaudeMd: false });

  it('第 1 层：name 精确等值（大小写不敏感）→ 直接命中，不看其他候选', () => {
    const ps = [proj('/root/projects/studio'), proj('/root/projects/studio-config')];
    expect(matchProjectByReply('STUDIO', ps)).toEqual({ kind: 'hit', project: ps[0] });
  });

  it('第 1 层：path 精确等值（大小写不敏感）→ 直接命中', () => {
    const ps = [proj('/root/projects/studio'), proj('/root/projects/studio-config')];
    expect(matchProjectByReply('/ROOT/PROJECTS/STUDIO', ps)).toEqual({ kind: 'hit', project: ps[0] });
  });

  it('第 2 层：尾段边界部分路径唯一命中；studio 不误命中 studio-config/studio-prod', () => {
    const ps = [
      proj('/root/projects/studio'),
      proj('/root/projects/studio-config'),
      proj('/root/projects/studio-prod'),
    ];
    expect(matchProjectByReply('projects/studio', ps)).toEqual({ kind: 'hit', project: ps[0] });
  });

  it('第 1 层 name 精确多命中 → 落候选列表不误绑', () => {
    const ps = [proj('/a/g1/tool'), proj('/b/g2/tool')];
    const m = matchProjectByReply('tool', ps);
    expect(m.kind).toBe('candidates');
    expect(m.kind === 'candidates' ? m.projects : []).toHaveLength(2);
  });

  it('第 2 层尾段边界多命中 → 落候选列表不误绑', () => {
    const ps = [proj('/a/g/tool'), proj('/b/g/tool'), proj('/c/other')];
    const m = matchProjectByReply('g/tool', ps);
    expect(m.kind).toBe('candidates');
    expect(m.kind === 'candidates' ? m.projects : []).toHaveLength(2);
  });

  it('前两层落空 → 子串匹配产出候选列表', () => {
    const ps = [proj('/root/projects/alpha-one'), proj('/root/projects/beta')];
    expect(matchProjectByReply('alpha', ps)).toEqual({ kind: 'candidates', projects: [ps[0]] });
  });
});

describe('#265: 分层匹配解挂（命中即停）', () => {
  it('回复精确工程名（大小写不敏感）一次解挂', async () => {
    const repoDir = makeDiscoveredProject('alpha');
    makeDiscoveredProject('alpha-two');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'ALPHA', fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('unassigned');
    expect(after.assigneeId).toBe(MENTIONED_PROFILE_ID); // mention 语义不变
    expect(metaOf(after).workspaceRoot).toBe(repoDir);
  });

  it('studio / studio-config / studio-prod 共存：回复 studio 唯一精确命中，不误绑兄弟仓', async () => {
    const repoDir = makeDiscoveredProject('studio');
    makeDiscoveredProject('studio-config');
    makeDiscoveredProject('studio-prod');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'studio', fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(repoDir);
  });

  it('路径尾段边界部分路径唯一命中 → 解挂', async () => {
    const repoDir = makeNestedProject('group', 'alpha');
    makeDiscoveredProject('alpha-two');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'group/alpha', fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(repoDir);
  });

  it('尾段边界命中不唯一 → 落候选列表而非误绑', async () => {
    makeNestedProject('g1', 'tool');
    makeNestedProject('g2', 'tool');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, 'tool', fileStore);

    expect(resumed).toBe(false);
    const after = await findWu(wu.id);
    expect(after.status).toBe('blocked');
    expect(metaOf(after).workspaceRoot).toBeUndefined(); // 未误绑
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.agentName === 'Studio');
    expect(notice).toBeTruthy();
    expect(notice!.content).toContain('匹配到多个工程');
    expect(notice!.content).toContain('g1');
    expect(notice!.content).toContain('g2');
  });
});

describe('#265: 绝对路径直连（绕过 search 歧义）', () => {
  it('回复合法工程绝对路径 → 直接绑定（兄弟仓同名前缀不构成歧义）', async () => {
    makeDiscoveredProject('studio');
    const configDir = makeDiscoveredProject('studio-config');
    makeDiscoveredProject('studio-prod');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, configDir, fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('unassigned');
    expect(metaOf(after).workspaceRoot).toBe(configDir);
  });

  it('discovery root 之外的合法工程路径同样直连（stat + isProject 校验）', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-ownership-outside-'));
    fs.writeFileSync(path.join(outside, 'package.json'), '{}');
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, outside, fileStore);

    expect(resumed).toBe(true);
    expect(metaOf(await findWu(wu.id)).workspaceRoot).toBe(outside);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('不存在的绝对路径 → 不绑定，继续等待', async () => {
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, '/nonexistent/definitely-not-a-project', fileStore);

    expect(resumed).toBe(false);
    const after = await findWu(wu.id);
    expect(after.status).toBe('blocked');
    expect(metaOf(after).workspaceRoot).toBeUndefined();
  });

  it('存在但无工程标记的目录 → 不绑定，继续等待', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-ownership-plain-'));
    const { wu } = await createOwnershipParkedWu();

    const resumed = await resumeWaitingWorkUnit(wu.id, plain, fileStore);

    expect(resumed).toBe(false);
    const after = await findWu(wu.id);
    expect(after.status).toBe('blocked');
    expect(metaOf(after).workspaceRoot).toBeUndefined();
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('#265: 3 轮未解终止转人工', () => {
  it('同一 WU 3 轮未解 → 停止追问 + 播报转人工 + WU 保持 blocked；之后未解回复不再发声', async () => {
    makeDiscoveredProject('gamma');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, 'zzz-1', fileStore)).toBe(false);
    expect(await resumeWaitingWorkUnit(wu.id, 'zzz-2', fileStore)).toBe(false);
    expect(await resumeWaitingWorkUnit(wu.id, 'zzz-3', fileStore)).toBe(false);

    const after = await findWu(wu.id);
    expect(after.status).toBe('blocked');
    const meta = metaOf(after);
    expect(meta.waitingForInput).toBe(true);
    expect(meta.ownershipAttempts).toBe(3);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notices = messages.filter(m => m.agentName === 'Studio');
    // 前 2 轮候选提示 + 第 3 轮转人工播报，不多发
    expect(notices).toHaveLength(3);
    expect(notices[2].content).toContain('转人工');
    expect(notices[2].content).not.toContain('可选工程');

    // 第 4 轮未解回复：停止追问后不再发任何消息
    expect(await resumeWaitingWorkUnit(wu.id, 'zzz-4', fileStore)).toBe(false);
    const later = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(later.filter(m => m.agentName === 'Studio')).toHaveLength(3);
    expect((await findWu(wu.id)).status).toBe('blocked');
  });

  it('3 轮后回复有效精确名仍可绑定解挂，轮次计数清除', async () => {
    const repoDir = makeDiscoveredProject('gamma');
    const { wu } = await createOwnershipParkedWu();
    await resumeWaitingWorkUnit(wu.id, 'zzz-1', fileStore);
    await resumeWaitingWorkUnit(wu.id, 'zzz-2', fileStore);
    await resumeWaitingWorkUnit(wu.id, 'zzz-3', fileStore);

    const resumed = await resumeWaitingWorkUnit(wu.id, 'gamma', fileStore);

    expect(resumed).toBe(true);
    const after = await findWu(wu.id);
    expect(after.status).toBe('unassigned');
    expect(after.assigneeId).toBe(MENTIONED_PROFILE_ID); // mention 语义不变
    const meta = metaOf(after);
    expect(meta.workspaceRoot).toBe(repoDir);
    expect(meta.ownershipAttempts).toBeUndefined();
  });
});

describe('#267（决策 #250 D3）: 结构化选项卡 meta.options 发射', () => {
  /** 解析频道 Studio 通知消息的 meta（落盘形态为 JSON string） */
  function noticeMeta(notice: ChannelMessageData): Record<string, unknown> {
    return JSON.parse(typeof notice.meta === 'string' ? notice.meta : '{}');
  }

  it('多候选 → 消息 meta 带 options[]（label=工程名，description=path，value=path）', async () => {
    const dirOne = makeDiscoveredProject('beta-one');
    const dirTwo = makeDiscoveredProject('beta-two');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, 'beta', fileStore)).toBe(false);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.agentName === 'Studio')!;
    const meta = noticeMeta(notice);
    expect(meta.options).toEqual([
      { label: 'beta-one', description: dirOne, value: dirOne },
      { label: 'beta-two', description: dirTwo, value: dirTwo },
    ]);
  });

  it('无命中 → options 列出全部工程', async () => {
    const dirGamma = makeDiscoveredProject('gamma');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, 'zzz-no-match', fileStore)).toBe(false);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.agentName === 'Studio')!;
    const meta = noticeMeta(notice);
    expect(meta.options).toEqual([{ label: 'gamma', description: dirGamma, value: dirGamma }]);
  });

  it('点选选项（回复 value=工程绝对路径）→ 走绝对路径直连绑定解挂，轮次计数清除', async () => {
    const dirOne = makeDiscoveredProject('beta-one');
    makeDiscoveredProject('beta-two');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, 'beta', fileStore)).toBe(false);
    expect(metaOf(await findWu(wu.id)).ownershipAttempts).toBe(1);
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const options = noticeMeta(messages.find(m => m.agentName === 'Studio')!).options as { value: string }[];

    // 前端点选 = 把 option.value 作为内嵌回复发送（同一 resumeWaitingWorkUnit 通道）
    const resumed = await resumeWaitingWorkUnit(wu.id, options[0].value, fileStore);

    expect(resumed).toBe(true);
    const meta = metaOf(await findWu(wu.id));
    expect(meta.workspaceRoot).toBe(dirOne);
    expect(meta.ownershipAttempts).toBeUndefined();
  });

  it('点选「交给 agent 判断」类未解回复 → 同样计入归属尝试计数（#265 三轮终止联动）', async () => {
    makeDiscoveredProject('gamma');
    const { wu } = await createOwnershipParkedWu();

    expect(await resumeWaitingWorkUnit(wu.id, '交给 agent 判断', fileStore)).toBe(false);

    expect(metaOf(await findWu(wu.id)).ownershipAttempts).toBe(1);
    expect((await findWu(wu.id)).status).toBe('blocked');
  });
});
