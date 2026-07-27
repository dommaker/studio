/**
 * §10 P0 — claim 持久化 metadata.matchedSkills
 * → 决策 7 重构：skill 匹配从 claim 挪到 agent-loop step 时（消竞态、吃到 skill 库最新版）。
 * 本文件改为守卫新契约：claim 不再做 skill 匹配/落盘——
 * 不写 metadata.matchedSkills、不发 updated 事件、不再回读 instance/profile 解析职能域
 * （matchedSkills 由 agent-loop 在 step 时经 metadataUpdates 原子写入）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-persist-test-'));
process.env.SKILLS_DIR = testSkillsDir;

fs.mkdirSync(path.join(testSkillsDir, 'feature-dev'), { recursive: true });
fs.writeFileSync(
  path.join(testSkillsDir, 'feature-dev', 'SKILL.md'),
  '---\nname: feature-dev\ndescription: "xyzzy 无交集"\nagentTypes: [implement]\nstatus: published\n---\n\n# feature-dev\n',
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

describe('§10 P0 → 决策 7: claim 不再落盘 metadata.matchedSkills', () => {
  let service: WorkUnitService;

  const baseSnapshot = {
    id: 'wu-1', status: 'unassigned', scope: '实现用户登录', type: 'feature',
    parentId: null, assigneeId: null, failureType: null,
    retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
    metadata: null, claimedAt: null, completedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

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
    mockFileStore.getState.mockResolvedValue({ id: 'inst-1', roleId: 'role-1' });
    mockFileStore.getProfile.mockResolvedValue({ id: 'role-1', description: '负责实现' });

    service = new WorkUnitService(mockFileStore as never);
  });

  it('claim 成功但不写索引/事件（匹配挪到 step 时，无 fire-and-forget 落盘）', async () => {
    await service.claim('wu-1', 'inst-1');
    // 旧行为是 fire-and-forget 异步落盘 —— 留出足够时间窗证明其不再发生
    await new Promise(r => setTimeout(r, 50));

    expect(mockFileStore.upsertSnapshot).not.toHaveBeenCalled();
    expect(mockFileStore.appendEvent).not.toHaveBeenCalled();
  });

  it('claim 不再回读 instance/profile 解析职能域（autoLoadSkillsForAgent 已删除）', async () => {
    await service.claim('wu-1', 'inst-1');
    await new Promise(r => setTimeout(r, 50));

    expect(mockFileStore.getState).not.toHaveBeenCalled();
    expect(mockFileStore.getProfile).not.toHaveBeenCalled();
  });

  it('带 legacy metadata.skillHints 的 WU：claim 同样不消费、不落盘', async () => {
    const withHints = { ...baseSnapshot, metadata: JSON.stringify({ skillHints: ['feature-dev'] }) };
    let getIndexCalls = 0;
    mockFileStore.getIndex.mockImplementation(() => {
      getIndexCalls++;
      return getIndexCalls === 1
        ? [withHints]
        : [{ ...withHints, assigneeId: 'inst-1', status: 'active' }];
    });

    const claimed = await service.claim('wu-1', 'inst-1');
    await new Promise(r => setTimeout(r, 50));

    expect(claimed.status).toBe('active');
    expect(mockFileStore.upsertSnapshot).not.toHaveBeenCalled();
    // metadata 保持原样（skillHints 不再被路由/claim 写入，仅为历史数据兼容留存）
    expect(JSON.parse(claimed.metadata!).matchedSkills).toBeUndefined();
  });
});
