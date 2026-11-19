// §9.5: AgentLoop.observe() 频道作用域以 channel.members 为唯一事实源。
// members 含本 profile → 可见；不含（含空 members）→ 不可见；
// 频道配置读不到（map miss：加载失败/频道已删）→ 放行不裁决（不致停摆）。
// #696：profile.channels 过渡口径已随存量验收退役。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import type { WorkUnitData } from '../../workunit/workunit-crud.js';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';

const ROLE_ID = 'role-member';
const OTHER_ROLE_ID = 'role-other';
const CHANNEL_ID = 'ch-members';
const LEGACY_CHANNEL_ID = 'ch-legacy';

// 决策 9：description 不再解析 acceptedTypes（认领过滤已删，此处 description 仅为展示文本）
const baseRole = {
  id: ROLE_ID,
  name: 'member-agent',
  description: 'task executor (members test)',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('§9.5: observe() 过滤以 channel.members 为准', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-members-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 不 start()：注入 instance 后直接调私有 observe（同 assignee 测试模式） */
  function makeLoop(role: typeof baseRole) {
    return new AgentLoop(role, fileStore, {
      instance: {
        id: 'instance-1',
        roleId: role.id,
        sessionId: null,
        status: 'idle',
        currentWorkUnitId: null,
        startedAt: new Date().toISOString(),
        terminatedAt: null,
        lastHeartbeat: null,
        metadata: null,
      },
    });
  }

  async function createChannelConfig(id: string, members: string[]) {
    await fileStore.createChannel({
      id, name: `#${id}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(members),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }

  function createUnassigned(channelId: string) {
    return wuService.create({
      scope: '频道任务', channelId, type: 'task', status: 'unassigned', assigneeId: null,
    });
  }

  it('members 非空：本 profile 在 members 中 → 可见（即使 profile.channels 指向别处）', async () => {
    await createChannelConfig(CHANNEL_ID, [ROLE_ID]);
    const role = { ...baseRole, channels: JSON.stringify(['ch-stale']) };
    const wu = await createUnassigned(CHANNEL_ID);

    const obs = await makeLoop(role).observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);
  });

  it('members 非空：本 profile 不在 members 中 → 不可见（即使 profile.channels 含该频道）', async () => {
    await createChannelConfig(CHANNEL_ID, [OTHER_ROLE_ID]);
    const role = { ...baseRole, channels: JSON.stringify([CHANNEL_ID]) };
    const wu = await createUnassigned(CHANNEL_ID);

    const obs = await makeLoop(role).observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
  });

  it('members 为空：本 profile 不可见（#696 严格口径，不再回退 profile.channels）', async () => {
    await createChannelConfig(LEGACY_CHANNEL_ID, []);
    const role = { ...baseRole, channels: JSON.stringify([LEGACY_CHANNEL_ID]) };
    const wu = await createUnassigned(LEGACY_CHANNEL_ID);

    const obs = await makeLoop(role).observe();
    expect(obs.unassigned.map(w => w.id)).not.toContain(wu.id);
  });

  it('频道配置读不到（map miss）→ 放行可见（不致停摆）', async () => {
    // 不建 channel config —— loadChannelMembers map 中无该频道
    const wu = await createUnassigned(LEGACY_CHANNEL_ID);

    const obs = await makeLoop(baseRole).observe();
    expect(obs.unassigned.map(w => w.id)).toContain(wu.id);
  });
});
