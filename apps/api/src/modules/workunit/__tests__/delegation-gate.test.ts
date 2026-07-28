// A2A §4.1/§4.2: DelegationGate 单测 —— 每条规则通过/拒绝两路径
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；闸门本身纯代码零 LLM。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';
import { resolveStudioLogFile } from '../../../utils/studio-log-path.js';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit.service.js';
import {
  checkDelegation,
  checkTreeBudget,
  resolveMaxDepth,
  readCollab,
  effectiveParentCollab,
  MAX_DELEGATIONS_PER_PARENT,
  MAX_TREE_SIZE,
  TREE_TOKEN_BUDGET,
} from '../delegation-gate.js';

function makeProfile(id: string, name: string, status = 'active'): AgentProfileData {
  return {
    id, name, description: `${name} 的描述`, channels: '[]', status,
    provider: 'claude', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

describe('DelegationGate (A2A §4.1/§4.2)', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  const profileA = makeProfile('profile-a', 'AgentA');
  const profileB = makeProfile('profile-b', 'AgentB');
  const profileC = makeProfile('profile-c', 'AgentC');

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-gate-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-gate-${Date.now()}`;
    for (const p of [profileA, profileB, profileC]) {
      await fileStore.createProfile(p);
    }
    await fileStore.createChannel({
      id: channelId, name: '#gate-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: stringifyChannels([profileA.id, profileB.id, profileC.id]),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    delete process.env.STUDIO_COLLAB_MAX_DEPTH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 创建父 WU（默认 active，root，无 collab） */
  async function makeParent(metadata?: WorkUnitMetadata): Promise<WorkUnitData> {
    const wu = await wuService.create({
      scope: '父任务', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-a',
      ...(metadata ? { metadata } : {}),
    });
    return (await wuService.getById(wu.id))!;
  }

  function check(parent: WorkUnitData, targetName: string, delegator = profileA) {
    return checkDelegation({ fileStore, parent, delegator, targetName });
  }

  it('happy path：目标是本频道 active 成员 → 通过并返回目标 profile', async () => {
    const parent = await makeParent();
    const result = await check(parent, 'AgentB');
    expect(result.pass).toBe(true);
    expect(result.target?.id).toBe(profileB.id);
  });

  it('目标 profile 不存在 → 拒绝', async () => {
    const parent = await makeParent();
    const result = await check(parent, 'NoSuchAgent');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('不存在或未激活');
  });

  it('目标 profile 非 active → 拒绝', async () => {
    await fileStore.createProfile(makeProfile('profile-inactive', 'Inactive', 'inactive'));
    const parent = await makeParent();
    const result = await check(parent, 'Inactive');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('不存在或未激活');
  });

  it('members 非空：目标不是本频道成员 → 拒绝', async () => {
    await fileStore.updateChannel(channelId, { members: stringifyChannels([profileA.id]) });
    const parent = await makeParent();
    const result = await check(parent, 'AgentB');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('不是本频道成员');
  });

  it('members 为空：过渡期放行任意 active profile（同 message-routing 口径）', async () => {
    await fileStore.updateChannel(channelId, { members: '[]' });
    const parent = await makeParent();
    const result = await check(parent, 'AgentB');
    expect(result.pass).toBe(true);
  });

  it('目标 = 派出方自己 → 拒绝（禁止自派生）', async () => {
    const parent = await makeParent();
    const result = await check(parent, 'AgentA');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('不能委派给自己');
  });

  it('深度：root（depth=0）可委派（depth+1=1 ≤ MAX_DEPTH=2）', async () => {
    const parent = await makeParent();
    expect(resolveMaxDepth()).toBe(2);
    const result = await check(parent, 'AgentB');
    expect(result.pass).toBe(true);
  });

  it('深度：depth=1 的子 WU 再委派（第二跳）在默认 MAX_DEPTH=2 下放行', async () => {
    const parent = await makeParent({
      collab: { rootId: 'root-wu', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 },
    });
    const result = await check(parent, 'AgentC', profileB);
    expect(result.pass).toBe(true);
  });

  it('深度：STUDIO_COLLAB_MAX_DEPTH=1 时第二跳拒绝', async () => {
    process.env.STUDIO_COLLAB_MAX_DEPTH = '1';
    expect(resolveMaxDepth()).toBe(1);
    const parent = await makeParent({
      collab: { rootId: 'root-wu', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 },
    });
    const result = await check(parent, 'AgentC', profileB);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('深度上限');
  });

  it('深度：STUDIO_COLLAB_MAX_DEPTH=3 时第三跳放行', async () => {
    const profileD = makeProfile('profile-d', 'AgentD');
    await fileStore.createProfile(profileD);
    await fileStore.updateChannel(channelId, { members: stringifyChannels([profileA.id, profileB.id, profileC.id, profileD.id]) });
    process.env.STUDIO_COLLAB_MAX_DEPTH = '3';
    expect(resolveMaxDepth()).toBe(3);
    const parent = await makeParent({
      collab: { rootId: 'root-wu', depth: 2, chain: [profileA.id, profileB.id, profileC.id], delegationCount: 0 },
    });
    const result = await check(parent, 'AgentD', profileC);
    expect(result.pass).toBe(true);
  });

  it('宽度：第 4 次委派（delegationCount=3）拒绝；count=2 放行', async () => {
    const atLimit = await makeParent({
      collab: { rootId: 'root-wu', depth: 0, chain: [profileA.id], delegationCount: MAX_DELEGATIONS_PER_PARENT },
    });
    const rejected = await check(atLimit, 'AgentB');
    expect(rejected.pass).toBe(false);
    expect(rejected.reason).toContain('委派次数已达上限');

    const underLimit = await makeParent({
      collab: { rootId: 'root-wu-2', depth: 0, chain: [profileA.id], delegationCount: MAX_DELEGATIONS_PER_PARENT - 1 },
    });
    expect((await check(underLimit, 'AgentB')).pass).toBe(true);
  });

  it('树规模：第 9 个 WU（root + 7 子孙 + 本次 = 9）拒绝；7 个时放行', async () => {
    const parent = await makeParent({
      collab: { rootId: 'root-tree', depth: 0, chain: [profileA.id], delegationCount: 2 },
    });
    // root-tree 自身 + 6 个子孙 = 7 → 放行
    for (let i = 0; i < MAX_TREE_SIZE - 2; i++) {
      await wuService.create({
        scope: `子孙 ${i}`, channelId, type: 'task', status: 'done',
        metadata: { collab: { rootId: 'root-tree', depth: 1, chain: [profileA.id, `x-${i}`], delegationCount: 0 } },
      });
    }
    expect((await check(parent, 'AgentB')).pass).toBe(true);
    // 再加 1 个 → 共 8 → 第 9 个拒绝
    await wuService.create({
      scope: '子孙 7', channelId, type: 'task', status: 'done',
      metadata: { collab: { rootId: 'root-tree', depth: 1, chain: [profileA.id, 'x-7'], delegationCount: 0 } },
    });
    const rejected = await check(parent, 'AgentB');
    expect(rejected.pass).toBe(false);
    expect(rejected.reason).toContain('协作树规模已达上限');
  });

  it('环：A→B→A —— B 回派 A 时目标已在 chain 中 → 拒绝（MAX_DEPTH=2）', async () => {
    process.env.STUDIO_COLLAB_MAX_DEPTH = '2';
    const childOfAB = await makeParent({
      collab: { rootId: 'root-wu', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 },
    });
    const result = await check(childOfAB, 'AgentA', profileB);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('已在委派链中');
  });

  it('重复委派：同（父, 目标）存在未完结子 WU → 拒绝；子已 done → 放行', async () => {
    const parent = await makeParent({
      collab: { rootId: 'root-dup', depth: 0, chain: [profileA.id], delegationCount: 1 },
    });
    await wuService.create({
      scope: '已有子任务', channelId, type: 'task', status: 'active',
      parentId: parent.id, assigneeId: profileB.id,
      metadata: { collab: { rootId: 'root-dup', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 } },
    });
    const rejected = await check(parent, 'AgentB');
    expect(rejected.pass).toBe(false);
    expect(rejected.reason).toContain('未完结子任务');

    // 子 WU done 后不再算重复
    const parent2 = await makeParent({
      collab: { rootId: 'root-dup2', depth: 0, chain: [profileA.id], delegationCount: 1 },
    });
    await wuService.create({
      scope: '已完成子任务', channelId, type: 'task', status: 'done',
      parentId: parent2.id, assigneeId: profileB.id,
      metadata: { collab: { rootId: 'root-dup2', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 } },
    });
    expect((await check(parent2, 'AgentB')).pass).toBe(true);
  });

  it('重复委派：子 WU 已 claim（assigneeId 被改写为 instance id）仍经 collab.chain 识别', async () => {
    const parent = await makeParent({
      collab: { rootId: 'root-dup3', depth: 0, chain: [profileA.id], delegationCount: 1 },
    });
    const child = await wuService.create({
      scope: '已被认领的子任务', channelId, type: 'task', status: 'unassigned',
      parentId: parent.id, assigneeId: profileB.id,
      metadata: { collab: { rootId: 'root-dup3', depth: 1, chain: [profileA.id, profileB.id], delegationCount: 0 } },
    });
    // 模拟 claim 后 assigneeId 改写为 instance id（§1.2-b 双语义）
    await wuService.update(child.id, { assigneeId: 'instance-b-xyz' });
    const result = await check(parent, 'AgentB');
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('未完结子任务');
  });

  it('预算：checkTreeBudget 无事件文件 -> pass + treeTotal=0', async () => {
    const parent = await makeParent();
    const result = await checkTreeBudget(parent.id, fileStore);
    expect(result.pass).toBe(true);
    expect(result.treeTotal).toBe(0);
  });

  it('预算：checkTreeBudget 超限 -> fail + reason 含数字', async () => {
    const parent = await makeParent();
    // 写入超预算的 token 事件
    // P0 修复 5：模块在测试环境已隔离到 os.tmpdir()/studio-test-logs，夹具写同一路径
    const eventsFile = resolveStudioLogFile('studio-events.jsonl');
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const overBudget = TREE_TOKEN_BUDGET + 10_000;
    fs.writeFileSync(eventsFile, JSON.stringify({
      type: 'workunit:tokens',
      payload: JSON.stringify({ workUnitId: parent.id, injectedTokens: 0, executionTokens: overBudget }),
      createdAt: new Date().toISOString(),
    }) + '\n');
    try {
      const result = await checkTreeBudget(parent.id, fileStore);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain(String(overBudget));
      expect(result.reason).toContain(String(TREE_TOKEN_BUDGET));
      expect(result.treeTotal).toBe(overBudget);
    } finally {
      fs.rmSync(eventsFile, { force: true });
    }
  });

  it('readCollab / effectiveParentCollab：缺失、损坏与根默认口径', async () => {
    expect(readCollab(null)).toBeNull();
    expect(readCollab('not-json')).toBeNull();
    expect(readCollab('{"collab":{"rootId":1}}')).toBeNull();

    const parent = await makeParent();
    const collab = effectiveParentCollab(parent, profileA.id);
    expect(collab).toEqual({
      rootId: parent.id, depth: 0, chain: [profileA.id], delegationCount: 0,
    });
  });
});
