/**
 * §10 P0 — claim 持久化 metadata.matchedSkills
 *
 * 域匹配（角色 acceptedTypes ∪ WU type）∩ skill.agentTypes 命中后，
 * 匹配结果写入 WU metadata.matchedSkills（best-effort，fire-and-forget）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-persist-test-'));
process.env.SKILLS_DIR = testSkillsDir;

// description 与 scope 零文本交集 —— 只能被域匹配命中（证明走的是主信号）
fs.mkdirSync(path.join(testSkillsDir, 'feature-dev'), { recursive: true });
fs.writeFileSync(
  path.join(testSkillsDir, 'feature-dev', 'SKILL.md'),
  '---\nname: feature-dev\ndescription: "xyzzy 无交集"\nagentTypes: [feature]\nstatus: published\n---\n\n# feature-dev\n',
  'utf-8',
);

const { mockFileStore } = vi.hoisted(() => ({
  mockFileStore: {
    getIndex: vi.fn(),
    claimWorkUnit: vi.fn(),
    upsertSnapshot: vi.fn(),
    appendEvent: vi.fn(),
    removeSnapshot: vi.fn(),
    getState: vi.fn(),
    getProfile: vi.fn(),
  },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { WorkUnitService } = await import('../../workunit/workunit.service.js');
const { invalidateManifestCache } = await import('../manifest-loader.js');

describe('§10 P0: claim 持久化 metadata.matchedSkills', () => {
  let service: WorkUnitService;

  /**
   * B3a 后 claim 链路有多次 upsertSnapshot：第一次是 timeoutAt 列写入（metadata 原样），
   * matchedSkills 落盘是 autoLoad 异步链上的后续调用 —— 按 metadata 内容定位目标调用。
   */
  const findMatchedSkillsUpsert = () =>
    mockFileStore.upsertSnapshot.mock.calls
      .map(c => c[0])
      .find(s => s?.metadata && String(s.metadata).includes('matchedSkills'));

  const baseSnapshot = {
    id: 'wu-1', status: 'unassigned', scope: '实现用户登录', type: 'feature',
    parentId: null, assigneeId: null, failureType: null,
    retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
    metadata: null, claimedAt: null, completedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateManifestCache();

    let getIndexCalls = 0;
    mockFileStore.getIndex.mockImplementation(() => {
      getIndexCalls++;
      return getIndexCalls === 1
        ? [baseSnapshot]
        : [{ ...baseSnapshot, assigneeId: 'inst-1', status: 'active' }];
    });
    mockFileStore.claimWorkUnit.mockResolvedValue(true);
    mockFileStore.upsertSnapshot.mockResolvedValue(undefined);
    mockFileStore.appendEvent.mockResolvedValue(undefined);
    // agentId = instance id → roleId → profile.description（含 feature 关键词）
    mockFileStore.getState.mockResolvedValue({ id: 'inst-1', roleId: 'role-1' });
    mockFileStore.getProfile.mockResolvedValue({ id: 'role-1', description: '负责 feature 开发' });

    service = new WorkUnitService(mockFileStore as never);
  });

  it('域匹配命中后写入 metadata.matchedSkills', async () => {
    await service.claim('wu-1', 'inst-1');

    // autoLoad 是 fire-and-forget —— 等待异步链落盘（跳过 B3a timeoutAt 的首次 upsert）
    await vi.waitFor(() => {
      expect(findMatchedSkillsUpsert()).toBeTruthy();
    });

    const updated = findMatchedSkillsUpsert();
    expect(updated.id).toBe('wu-1');
    const meta = JSON.parse(updated.metadata);
    expect(meta.matchedSkills).toEqual(['feature-dev']);
  });

  it('profile 解析失败时降级为仅 WU type 匹配（不阻塞 claim）', async () => {
    mockFileStore.getState.mockRejectedValue(new Error('store down'));

    await service.claim('wu-1', 'inst-1');

    // WU type = feature 仍能命中 agentTypes [feature]
    await vi.waitFor(() => {
      expect(findMatchedSkillsUpsert()).toBeTruthy();
    });
    const updated = findMatchedSkillsUpsert();
    expect(JSON.parse(updated.metadata).matchedSkills).toEqual(['feature-dev']);
  });
});
