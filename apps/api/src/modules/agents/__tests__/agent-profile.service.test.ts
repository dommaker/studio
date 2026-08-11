/**
 * AgentProfile CRUD 测试 — AS-025 Phase 2
 * Storage: FileStore（迁移自 Prisma）
 */
import { describe, it, expect, vi, afterAll, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { AgentProfileService, ensureStudioProfile, STUDIO_ROLE_DESCRIPTION, STUDIO_ROLE_DEFAULT_PROVIDER } from '../agent-profile.service.js';

// F1: provider 缺省打戳的扫描结果 mock 为固定 'claude'（真机扫描结果随机器漂移，测试要确定）
vi.mock('../default-provider.js', () => ({
  resolveDefaultProvider: vi.fn(() => 'claude'),
}));

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profile-test-'));
}

describe('AgentProfile CRUD', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: AgentProfileService;
  const testProfileIds: string[] = [];

  beforeAll(() => {
    tmpDir = createTempDir();
    fileStore = new FileStore(tmpDir);
    service = new AgentProfileService(fileStore);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create with minimal fields', async () => {
    const profile = await service.create({ name: 'test-pm' });
    testProfileIds.push(profile.id);

    expect(profile.id).toBeDefined();
    expect(profile.name).toBe('test-pm');
    expect(profile.description).toBeNull();
    expect(profile.channels).toBe('[]');
    expect(profile.status).toBe('active');
  });

  it('create with all fields', async () => {
    const profile = await service.create({
      name: 'test-engineer',
      description: 'Writes code',
      channels: ['ch-1', 'ch-2'],
    });
    testProfileIds.push(profile.id);

    expect(profile.name).toBe('test-engineer');
    expect(profile.description).toBe('Writes code');
    expect(profile.channels).toBe('["ch-1","ch-2"]');
  });

  it('create duplicate name throws', async () => {
    await service.create({ name: 'test-dup' });
    await expect(service.create({ name: 'test-dup' })).rejects.toThrow();
  });

  it('get by id', async () => {
    const created = await service.create({ name: 'test-get' });
    testProfileIds.push(created.id);

    const found = await service.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('test-get');
  });

  it('get nonexistent returns null', async () => {
    const found = await service.getById('nonexistent');
    expect(found).toBeNull();
  });

  it('list with filter', async () => {
    await service.create({ name: 'test-list-active', status: 'active' });
    await service.create({ name: 'test-list-inactive', status: 'inactive' });

    const active = await service.list({ status: 'active' });
    expect(active.data.every(p => p.status === 'active')).toBe(true);
  });

  it('update', async () => {
    const created = await service.create({ name: 'test-update' });
    testProfileIds.push(created.id);

    const updated = await service.update(created.id, {
      description: 'Updated description',
      channels: ['ch-new'],
    });

    expect(updated.description).toBe('Updated description');
    expect(updated.channels).toBe('["ch-new"]');
  });

  // ── F3: channels 写入端归一化（历史双编码 bug） ──

  it('create normalizes legacy string-encoded channels input', async () => {
    const profile = await service.create({
      name: 'test-normalize-create',
      // 旧 web 客户端会发送已 JSON 编码的字符串（而非数组）
      channels: JSON.stringify(['ch-1']) as unknown as string[],
    });
    testProfileIds.push(profile.id);
    expect(profile.channels).toBe('["ch-1"]');
    const onDisk = await service.getById(profile.id);
    expect(onDisk!.channels).toBe('["ch-1"]');
  });

  it('update normalizes double-encoded channels input', async () => {
    const created = await service.create({ name: 'test-normalize-update' });
    testProfileIds.push(created.id);

    const updated = await service.update(created.id, {
      channels: JSON.stringify(JSON.stringify(['ch-2'])) as unknown as string[],
    });
    expect(updated.channels).toBe('["ch-2"]');
  });

  it('delete', async () => {
    const created = await service.create({ name: 'test-delete' });
    await service.delete(created.id);

    const found = await service.getById(created.id);
    expect(found).toBeNull();
  });

  // ── AC Group 1: provider field ──

  it('create with provider field', async () => {
    const profile = await service.create({
      name: 'test-provider-claude',
      provider: 'claude',
    });
    testProfileIds.push(profile.id);
    expect(profile.provider).toBe('claude');
  });

  it('create without provider 打戳为扫描到的默认 provider（F1，不再留 null 靠运行时隐式兜底）', async () => {
    const profile = await service.create({ name: 'test-no-provider' });
    testProfileIds.push(profile.id);
    expect(profile.provider).toBe('claude'); // default-provider mock 固定 'claude'
  });

  it('update provider field', async () => {
    const created = await service.create({ name: 'test-update-provider' });
    testProfileIds.push(created.id);

    const updated = await service.update(created.id, { provider: 'codex' });
    expect(updated.provider).toBe('codex');
  });

  it('update provider to null clears it', async () => {
    const created = await service.create({ name: 'test-clear-provider', provider: 'claude' });
    testProfileIds.push(created.id);

    const updated = await service.update(created.id, { provider: null });
    expect(updated.provider).toBeNull();
  });

  it('list with provider filter', async () => {
    const c1 = await service.create({ name: 'test-list-provider-1', provider: 'claude' });
    const c2 = await service.create({ name: 'test-list-provider-2', provider: 'codex' });
    const c3 = await service.create({ name: 'test-list-provider-3' }); // F1: 缺省打戳 'claude'
    testProfileIds.push(c1.id, c2.id, c3.id);

    const claudeOnly = await service.list({ provider: 'claude' });
    const claudeIds = claudeOnly.data.map(p => p.id);
    expect(claudeIds).toContain(c1.id);
    expect(claudeIds).not.toContain(c2.id);
    expect(claudeIds).toContain(c3.id);
  });

  it('list with provider=null returns only null-provider profiles', async () => {
    const withProvider = await service.create({ name: 'test-provider-filter', provider: 'claude' });
    // F1: create 缺省会打戳，null 态只能经 update 到达
    const cleared = await service.create({ name: 'test-null-provider-filter', provider: 'claude' });
    await service.update(cleared.id, { provider: null });
    testProfileIds.push(withProvider.id, cleared.id);

    const result = await service.list({ provider: null });
    const ids = result.data.map(p => p.id);
    expect(ids).toContain(cleared.id);
    expect(ids).not.toContain(withProvider.id);
  });
});

// ── AC-A2: listAgents online status + channelId filter ──

describe('AC-A2: listAgents online status + channelId filter', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: AgentProfileService;
  const testProfileIds: string[] = [];
  const runtimeIds: string[] = [];

  beforeAll(() => {
    tmpDir = createTempDir();
    fileStore = new FileStore(tmpDir);
    service = new AgentProfileService(fileStore);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testProfileIds.length = 0;
    runtimeIds.length = 0;
  });

  it('list() returns results with isOnline field', async () => {
    const profile = await service.create({ name: 'online-test-1' });
    testProfileIds.push(profile.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found).toBeDefined();
    expect(found).toHaveProperty('isOnline');
  });

  it('isOnline=true when RuntimeState status=active exists', async () => {
    const now = new Date().toISOString();
    const profile = await service.create({ name: 'online-test-2' });
    testProfileIds.push(profile.id);
    const stateId = `ri-${profile.id}`;
    await fileStore.createState(stateId, {
      id: stateId, roleId: profile.id, sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: now, terminatedAt: null,
      lastHeartbeat: null, metadata: null,
    });
    runtimeIds.push(stateId);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(true);
  });

  it('isOnline=false when no RuntimeState exists', async () => {
    const profile = await service.create({ name: 'online-test-3' });
    testProfileIds.push(profile.id);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(false);
  });

  it('isOnline=true when RuntimeState status=idle with fresh heartbeat (idle loop is alive)', async () => {
    const now = new Date().toISOString();
    const profile = await service.create({ name: 'online-test-4' });
    testProfileIds.push(profile.id);
    const stateId = `ri-${profile.id}`;
    await fileStore.createState(stateId, {
      id: stateId, roleId: profile.id, sessionId: null, status: 'idle',
      currentWorkUnitId: null, startedAt: now, terminatedAt: null,
      lastHeartbeat: now, metadata: null,
    });
    runtimeIds.push(stateId);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(true);
  });

  it('isOnline=false when heartbeat is stale (loop considered dead)', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 分钟前，超过 5 分钟阈值
    const profile = await service.create({ name: 'online-test-5' });
    testProfileIds.push(profile.id);
    const stateId = `ri-${profile.id}`;
    await fileStore.createState(stateId, {
      id: stateId, roleId: profile.id, sessionId: null, status: 'idle',
      currentWorkUnitId: null, startedAt: old, terminatedAt: null,
      lastHeartbeat: old, metadata: null,
    });
    runtimeIds.push(stateId);

    const result = await service.list({ status: 'active' });
    const found = result.data.find(p => p.id === profile.id);
    expect(found!.isOnline).toBe(false);
  });

  it('list({ channelId }) filters agents by Channel.members', async () => {
    const agent1 = await service.create({ name: 'channel-agent-1' });
    const agent2 = await service.create({ name: 'channel-agent-2', channels: [] });
    testProfileIds.push(agent1.id, agent2.id);

    // Set Channel.members to include agent1 (canonical source)
    const ch1Id = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: ch1Id, name: `#test-ac-a2-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify([agent1.id]),
      createdAt: now, updatedAt: now,
    });

    const result = await service.list({ channelId: ch1Id });
    const ids = result.data.map(p => p.id);
    expect(ids).toContain(agent1.id);
    expect(ids).not.toContain(agent2.id);

    await fileStore.deleteChannel(ch1Id);
  });

  it('list({ channelId }) returns all active agents when Channel.members=[]', async () => {
    const ch2Id = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: ch2Id, name: `#test-ac-a2-empty-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: now, updatedAt: now,
    });
    const agent3 = await service.create({ name: 'channel-agent-3' });
    testProfileIds.push(agent3.id);

    const result = await service.list({ channelId: ch2Id });
    // Empty members → returns all active agents (fallback)
    expect(result.data.length).toBeGreaterThanOrEqual(1);

    await fileStore.deleteChannel(ch2Id);
  });
});

// ── AC Group 1: 内置 studio 角色 ──

describe('AC Group 1: studio role', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: AgentProfileService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-role-test-'));
    fileStore = new FileStore(tmpDir);
    service = new AgentProfileService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensureStudioProfile', () => {
    it('首次调用创建 name=studio 的 profile，provider=缺省值（L2）', async () => {
      const profile = await ensureStudioProfile(fileStore);
      expect(profile.name).toBe('studio');
      expect(profile.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
      expect(profile.status).toBe('active');
      expect(profile.channels).toBe('[]');
      // B4a: studio 定位描述随种子写入
      expect(profile.description).toBe(STUDIO_ROLE_DESCRIPTION);
    });

    it('存量 studio provider 为空（未配置）时回填缺省 provider（L2）', async () => {
      const now = new Date().toISOString();
      await fileStore.createProfile({
        id: 'studio-noprovider', name: 'studio', description: STUDIO_ROLE_DESCRIPTION,
        channels: '[]', provider: null, status: 'active',
        createdAt: now, updatedAt: now,
      });

      const profile = await ensureStudioProfile(fileStore);
      expect(profile.id).toBe('studio-noprovider');
      expect(profile.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
      // 落盘确认 + 幂等（第二次调用结果不变）
      const onDisk = await fileStore.getProfile('studio-noprovider');
      expect(onDisk!.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
      const again = await ensureStudioProfile(fileStore);
      expect(again.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
    });

    it('存量 studio provider 为用户显式配置时不覆盖（L2）', async () => {
      const now = new Date().toISOString();
      await fileStore.createProfile({
        id: 'studio-custom-provider', name: 'studio', description: STUDIO_ROLE_DESCRIPTION,
        channels: '[]', provider: 'kimi', status: 'active',
        createdAt: now, updatedAt: now,
      });

      const profile = await ensureStudioProfile(fileStore);
      expect(profile.provider).toBe('kimi');
      const onDisk = await fileStore.getProfile('studio-custom-provider');
      expect(onDisk!.provider).toBe('kimi');
    });

    it('存量 studio description 与 provider 同时为空时一并回填', async () => {
      const now = new Date().toISOString();
      await fileStore.createProfile({
        id: 'studio-legacy-both', name: 'studio', description: null,
        channels: '[]', provider: null, status: 'active',
        createdAt: now, updatedAt: now,
      });

      const profile = await ensureStudioProfile(fileStore);
      expect(profile.description).toBe(STUDIO_ROLE_DESCRIPTION);
      expect(profile.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
      const onDisk = await fileStore.getProfile('studio-legacy-both');
      expect(onDisk!.description).toBe(STUDIO_ROLE_DESCRIPTION);
      expect(onDisk!.provider).toBe(STUDIO_ROLE_DEFAULT_PROVIDER);
    });

    it('存量 studio description 为空（旧默认）时回填定位描述', async () => {
      const now = new Date().toISOString();
      await fileStore.createProfile({
        id: 'studio-legacy', name: 'studio', description: null,
        channels: '[]', provider: null, status: 'active',
        createdAt: now, updatedAt: now,
      });

      const profile = await ensureStudioProfile(fileStore);
      expect(profile.id).toBe('studio-legacy');
      expect(profile.description).toBe(STUDIO_ROLE_DESCRIPTION);
      // 落盘确认 + 幂等（第二次调用结果不变）
      const onDisk = await fileStore.getProfile('studio-legacy');
      expect(onDisk!.description).toBe(STUDIO_ROLE_DESCRIPTION);
      const again = await ensureStudioProfile(fileStore);
      expect(again.description).toBe(STUDIO_ROLE_DESCRIPTION);
    });

    it('存量 studio description 为用户自定义时不覆盖', async () => {
      const now = new Date().toISOString();
      await fileStore.createProfile({
        id: 'studio-custom', name: 'studio', description: '用户自定义的系统角色说明',
        channels: '[]', provider: null, status: 'active',
        createdAt: now, updatedAt: now,
      });

      const profile = await ensureStudioProfile(fileStore);
      expect(profile.description).toBe('用户自定义的系统角色说明');
      const onDisk = await fileStore.getProfile('studio-custom');
      expect(onDisk!.description).toBe('用户自定义的系统角色说明');
    });

    it('已存在时跳过创建（幂等）', async () => {
      const first = await ensureStudioProfile(fileStore);
      const second = await ensureStudioProfile(fileStore);
      expect(second.id).toBe(first.id);
    });

    it('不发 agent-profile.created 事件（避免触发 mount）', async () => {
      const events: string[] = [];
      const handler = () => events.push('created');
      eventBus.subscribe('agent-profile.created', handler);
      try {
        await ensureStudioProfile(fileStore);
        expect(events).toHaveLength(0);
      } finally {
        eventBus.unsubscribe('agent-profile.created', handler);
      }
    });

    it('ensureStudioProfile 后 list 默认不含 studio（includeSystem=false）', async () => {
      await ensureStudioProfile(fileStore);
      const result = await service.list();
      expect(result.data.find(p => p.name === 'studio')).toBeUndefined();
    });
  });

  describe('create rejects studio name', () => {
    it('create name=studio 拒绝', async () => {
      await expect(service.create({ name: 'studio' })).rejects.toThrow(/studio.*reserved|reserved.*studio/i);
    });

    it('create name=Studio（大小写变体）允许（不保留）', async () => {
      // 只有精确 'studio' 保留，大小写变体不保留
      const profile = await service.create({ name: 'Studio' });
      expect(profile.name).toBe('Studio');
    });
  });

  describe('update rejects rename to studio', () => {
    it('update 改名到 studio 拒绝', async () => {
      const created = await service.create({ name: 'some-role' });
      await expect(service.update(created.id, { name: 'studio' })).rejects.toThrow(/studio.*reserved|reserved.*studio/i);
    });
  });

  describe('list includeSystem', () => {
    it('list({ includeSystem: true }) 包含 studio 角色', async () => {
      await ensureStudioProfile(fileStore);
      const result = await service.list({ includeSystem: true });
      expect(result.data.find(p => p.name === 'studio')).toBeDefined();
    });

    it('list 默认排除 studio 角色', async () => {
      await ensureStudioProfile(fileStore);
      const result = await service.list();
      expect(result.data.find(p => p.name === 'studio')).toBeUndefined();
    });
  });

  describe('delete rejects studio', () => {
    it('delete studio 角色拒绝', async () => {
      const studio = await ensureStudioProfile(fileStore);
      await expect(service.delete(studio.id)).rejects.toThrow(/studio.*cannot be deleted|cannot delete.*studio/i);
    });
  });
});

// ── 决策 9: create preset 从 .agents/roles/*.yaml 预填 ──

describe('决策 9: create preset 预填（.agents/roles/*.yaml）', () => {
  let tmpDir: string;
  let rolesDir: string;
  let fileStore: FileStore;
  let service: AgentProfileService;
  let savedRolesDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-preset-test-'));
    rolesDir = path.join(tmpDir, 'roles');
    fs.mkdirSync(rolesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolesDir, 'developer.yaml'),
      [
        'id: developer',
        'name: Developer',
        'description: 代码实现、TDD 流程',
        'acceptedTypes: [implement]',
        'skills: [tdd-implement, task-planner]',
        'tools: [read, write]',
        'constraints:',
        '  max_concurrent_tasks: 2',
        '  can_delegate: false',
        'persona: |',
        '  你是开发者。遵循 TDD 流程。',
        '',
      ].join('\n'),
      'utf-8',
    );
    fileStore = new FileStore(tmpDir);
    service = new AgentProfileService(fileStore);
    savedRolesDir = process.env.STUDIO_ROLES_DIR;
    process.env.STUDIO_ROLES_DIR = rolesDir;
  });

  afterEach(() => {
    if (savedRolesDir === undefined) delete process.env.STUDIO_ROLES_DIR;
    else process.env.STUDIO_ROLES_DIR = savedRolesDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preset 带入 description/persona/acceptedTypes', async () => {
    const profile = await service.create({ name: 'dev-1', preset: 'developer' });

    expect(profile.description).toBe('代码实现、TDD 流程');
    expect(profile.persona).toBe('你是开发者。遵循 TDD 流程。\n');
    expect(profile.acceptedTypes).toEqual(['implement']);
    // 落盘后可回读
    const onDisk = await service.getById(profile.id);
    expect(onDisk!.acceptedTypes).toEqual(['implement']);
    expect(onDisk!.persona).toContain('你是开发者');
  });

  it('显式传入字段优先于预设', async () => {
    const profile = await service.create({
      name: 'dev-2',
      preset: 'developer',
      description: '显式描述',
      persona: '显式 persona',
      acceptedTypes: ['review'],
    });

    expect(profile.description).toBe('显式描述');
    expect(profile.persona).toBe('显式 persona');
    expect(profile.acceptedTypes).toEqual(['review']);
  });

  it('显式传入 persona/acceptedTypes（无 preset）', async () => {
    const profile = await service.create({
      name: 'dev-3',
      persona: '直接给的 persona',
      acceptedTypes: ['test', 'review'],
    });

    expect(profile.persona).toBe('直接给的 persona');
    expect(profile.acceptedTypes).toEqual(['test', 'review']);
  });

  it('未知 preset 拒绝创建（防手误静默丢配置）', async () => {
    await expect(service.create({ name: 'dev-4', preset: 'no-such-role' }))
      .rejects.toThrow(/preset not found|not found.*preset/i);
  });

  it('含路径字符的 preset 拒绝创建（防目录穿越）', async () => {
    await expect(service.create({ name: 'dev-5', preset: '../../etc/passwd' }))
      .rejects.toThrow(/preset not found|not found.*preset/i);
  });

  it('无 preset 时行为不变（persona/acceptedTypes 不落盘）', async () => {
    const profile = await service.create({ name: 'dev-6' });

    expect(profile.description).toBeNull();
    expect(profile.persona).toBeUndefined();
    expect(profile.acceptedTypes).toBeUndefined();
  });

  it('#91: preset 带入 skills/tools/constraints 并落盘可回读（prompt 组装消费链不再断）', async () => {
    const profile = await service.create({ name: 'dev-7', preset: 'developer' });

    expect(profile.skills).toEqual(['tdd-implement', 'task-planner']);
    expect(profile.tools).toEqual(['read', 'write']);
    expect(profile.constraints).toEqual({ max_concurrent_tasks: 2, can_delegate: false });
    const onDisk = await service.getById(profile.id);
    expect(onDisk!.skills).toEqual(['tdd-implement', 'task-planner']);
    expect(onDisk!.tools).toEqual(['read', 'write']);
    expect(onDisk!.constraints).toEqual({ max_concurrent_tasks: 2, can_delegate: false });
  });
});
