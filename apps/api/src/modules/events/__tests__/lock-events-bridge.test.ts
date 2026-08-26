/**
 * lock.* 事件 → Monitor 告警桥单测（#169 / #64 决议 4）
 *  - eventBus 的 lock.stale_reclaimed / lock.acquire_timeout 被转发：
 *    结构化字段落统一事件流（lock.* 类型）+ dispatchMonitorAlerts 全管线
 *    （monitor:alert 事件 + notifyAlert 通知出口，warning 级）
 *  - 幂等：重复 init 不重复注册
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { eventsFile, tmpEventsDir, mockNotifyAlert } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-events-bridge-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return { eventsFile, tmpEventsDir: tmpEvents, mockNotifyAlert: vi.fn(() => Promise.resolve()) };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => { fs.rmSync(tmpEventsDir, { recursive: true, force: true }); });

vi.mock('../../../utils/notifier.js', () => ({
  notifyAlert: mockNotifyAlert,
}));

// monitor-alerts.ts 顶层依赖，与告警分发无关，mock 掉避免加载业务服务
vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { recordPattern: vi.fn(() => Promise.resolve()) },
}));
vi.mock('../agents/triage/triage.service.js', () => ({
  triageService: { handleAlert: vi.fn(() => Promise.resolve()) },
}));

import { eventBus } from '@dommaker/studio-shared';
import { initLockEventsBridge } from '../lock-events-bridge.js';

function readEventLines(): any[] {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('lock-events-bridge（#169）', () => {
  it('lock.* 事件走 dispatchMonitorAlerts 全管线 + 结构化字段落事件流；重复 init 幂等', async () => {
    initLockEventsBridge();
    initLockEventsBridge(); // 幂等：不应重复注册

    const stalePayload = {
      lockDir: '/data/locks/wu.lock',
      ownerPid: 1234,
      ownerAcquiredAt: 1786800000000,
      criterion: 'pid_dead',
      reclaimerPid: 5678,
    };
    const timeoutPayload = {
      lockDir: '/data/locks/wu.lock',
      waitedMs: 5000,
      owner: { pid: 1234, hostname: 'host-a', acquiredAt: 1786800000000 },
    };
    eventBus.publish('lock.stale_reclaimed', stalePayload);
    eventBus.publish('lock.acquire_timeout', timeoutPayload);

    // emitMonitorEvent / notifyAlert 均为 fire-and-forget —— 等待落盘
    await vi.waitFor(() => {
      expect(readEventLines()).toHaveLength(4); // 2 条 lock.* + 2 条 monitor:alert
    });

    const lines = readEventLines();
    const lockLines = lines.filter(l => l.type.startsWith('lock.'));
    // 两条写盘为 fire-and-forget，落盘顺序不保证，按类型各自定位
    expect(lockLines.map(l => l.type).sort()).toEqual(['lock.acquire_timeout', 'lock.stale_reclaimed']);
    const staleLine = lockLines.find(l => l.type === 'lock.stale_reclaimed');
    const timeoutLine = lockLines.find(l => l.type === 'lock.acquire_timeout');
    // 结构化字段原样保留
    expect(JSON.parse(staleLine.payload)).toMatchObject(stalePayload);
    expect(JSON.parse(timeoutLine.payload)).toMatchObject({
      lockDir: timeoutPayload.lockDir,
      waitedMs: timeoutPayload.waitedMs,
    });

    // dispatchMonitorAlerts 全管线：monitor:alert 事件 + notifyAlert 通知出口，均 warning 级
    const alertLines = lines.filter(l => l.type === 'monitor:alert');
    expect(alertLines).toHaveLength(2);
    for (const line of alertLines) {
      const payload = JSON.parse(line.payload);
      expect(payload.level).toBe('warning');
      expect(payload.source).toBe('lock');
    }
    expect(mockNotifyAlert).toHaveBeenCalledTimes(2); // 幂等生效：每事件仅一次
    expect(mockNotifyAlert).toHaveBeenCalledWith(
      'warning',
      '[Monitor] lock',
      expect.stringContaining('lock.stale_reclaimed'),
    );
    expect(mockNotifyAlert).toHaveBeenCalledWith(
      'warning',
      '[Monitor] lock',
      expect.stringContaining('lock.acquire_timeout'),
    );
  });
});
