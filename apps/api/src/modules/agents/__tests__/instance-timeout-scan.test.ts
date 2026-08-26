/**
 * #179（#66 决议 3 scan 侧）agent-timeout-scan pid 复核：
 * - 心跳过期但 pid 活 = FileStore 故障非 loop 死 → 不 terminate，发 warning 告警（#62 管线）
 * - pid 死 / 无 pid → 照常 terminate
 * 真实 FileStore（tmpdir）+ 真实 AgentInstanceService；告警出口 dispatchMonitorAlerts mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type RuntimeStateData } from '@dommaker/studio-shared';

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock('../monitor/monitor-alerts.js', () => ({
  dispatchMonitorAlerts: mockDispatch,
  // #220：scan 侧 dispatch 前过冷却；此处透传，冷却本体由 monitor-alert-cooldown.test.ts 覆盖
  filterCooldownAlerts: (alerts: unknown[]) => alerts,
}));

import { scanStaleAgentInstances } from '../instance-timeout-scan';

let tmpDir: string;
let fileStore: FileStore;

const STALE_HB = new Date(Date.now() - 10 * 60_000).toISOString(); // 10min 前（阈值 5min）
const FRESH_HB = new Date().toISOString();

function makeState(id: string, overrides: Partial<RuntimeStateData>): RuntimeStateData {
  return {
    id,
    roleId: 'role-1',
    sessionId: null,
    status: 'active',
    currentWorkUnitId: null,
    startedAt: new Date().toISOString(),
    terminatedAt: null,
    lastHeartbeat: STALE_HB,
    metadata: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-timeout-scan-'));
  fileStore = new FileStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#179: agent-timeout-scan terminate 前 pid 复核', () => {
  it('心跳过期 + pid 死 → 照常 terminate，不告警', async () => {
    await fileStore.createState('inst-dead', makeState('inst-dead', { pid: 2 ** 22 + 12345 })); // 必死 pid

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.terminated).toBe(1);
    expect(result.skippedAlive).toBe(0);
    expect((await fileStore.getState('inst-dead'))!.status).toBe('terminated');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('心跳过期 + pid 活 → 不 terminate，发 warning 告警走 #62 管线', async () => {
    // process.pid 即本测试进程：必活；startedAt=now → /proc 启动时间比对通过（非 pid 复用）
    await fileStore.createState('inst-alive', makeState('inst-alive', { pid: process.pid }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.terminated).toBe(0);
    expect(result.skippedAlive).toBe(1);
    expect((await fileStore.getState('inst-alive'))!.status).toBe('active'); // 未被误杀
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const alerts = mockDispatch.mock.calls[0][0];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].source).toBe('agent_timeout_scan');
    expect(alerts[0].subject).toBe('inst-alive'); // #220：指纹主体 = 实例 id
  });

  it('心跳过期 + 无 pid → 照常 terminate（无复核依据，保持既有行为）', async () => {
    await fileStore.createState('inst-nopid', makeState('inst-nopid', { pid: undefined }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.terminated).toBe(1);
    expect((await fileStore.getState('inst-nopid'))!.status).toBe('terminated');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('心跳新鲜 → 不动不告警', async () => {
    await fileStore.createState('inst-fresh', makeState('inst-fresh', { pid: 2 ** 22 + 12346, lastHeartbeat: FRESH_HB }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.stale).toBe(0);
    expect((await fileStore.getState('inst-fresh'))!.status).toBe('active');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('#363: terminated 实例统一回收（跨角色，清理职责收进 scan）', () => {
  it('terminated 实例被回收：state.json 与空实例目录一并消失（跨角色）', async () => {
    await fileStore.createState('term-a', makeState('term-a', { roleId: 'role-1', status: 'terminated' }));
    await fileStore.createState('term-b', makeState('term-b', { roleId: 'role-2', status: 'terminated' }));
    await fileStore.createState('live', makeState('live', { roleId: 'role-3', lastHeartbeat: FRESH_HB }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.reclaimed).toBe(2);
    expect(await fileStore.getState('term-a')).toBeNull();
    expect(await fileStore.getState('term-b')).toBeNull();
    // 目录闭环：空实例目录一并删除
    expect(fs.existsSync(path.join(tmpDir, 'agents', 'term-a'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'agents', 'term-b'))).toBe(false);
    // 活实例不动
    expect((await fileStore.getState('live'))!.status).toBe('active');
    expect(fs.existsSync(path.join(tmpDir, 'agents', 'live'))).toBe(true);
  });

  it('terminated 实例目录内有 profile.json → state 回收、目录保留', async () => {
    await fileStore.createProfile({
      id: 'term-profile', name: 'p', description: null, channels: '[]',
      status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await fileStore.createState('term-profile', makeState('term-profile', { status: 'terminated' }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.reclaimed).toBe(1);
    expect(await fileStore.getState('term-profile')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'agents', 'term-profile', 'profile.json'))).toBe(true);
  });

  it('无 terminated 实例 → reclaimed=0（幂等）', async () => {
    await fileStore.createState('live', makeState('live', { lastHeartbeat: FRESH_HB }));

    const result = await scanStaleAgentInstances(fileStore);

    expect(result.reclaimed).toBe(0);
    expect((await fileStore.getState('live'))!.status).toBe('active');
  });
});
