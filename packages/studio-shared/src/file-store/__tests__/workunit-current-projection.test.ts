import { describe, expect, it } from 'vitest';
import {
  parseWorkUnitCurrentManifest,
  parseWorkUnitCurrentProjection,
  sameWorkUnitLogPosition,
  workUnitProjectionFileName,
  type WorkUnitCurrentManifest,
} from '../workunit-current-projection';
import type { WorkUnitSnapshot } from '../file-store-types';

const head = { dev: 11, ino: 22, offset: 4096 };
const manifest: WorkUnitCurrentManifest = { version: 1, log: head, count: 1 };
const snapshot: WorkUnitSnapshot = {
  id: 'wu-1', parentId: null, type: 'task', scope: 'scope', assigneeId: null,
  status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
  channelId: null, projectPath: null, metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  claimedAt: null, completedAt: null,
};

describe('WorkUnit 当前态投影格式', () => {
  it('文件名使用 WU id 的 SHA-256，路径字符不进入文件名', () => {
    expect(workUnitProjectionFileName('wu-1')).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(workUnitProjectionFileName('../wu-1')).not.toContain('wu-1');
    expect(workUnitProjectionFileName('wu-1')).not.toBe(workUnitProjectionFileName('wu-2'));
  });

  it('manifest 解析保留 log byte offset 与 dev:ino 代际', () => {
    expect(parseWorkUnitCurrentManifest(JSON.stringify(manifest), 'manifest.json')).toEqual(manifest);
    expect(sameWorkUnitLogPosition(head, { ...head })).toBe(true);
    expect(sameWorkUnitLogPosition(head, { ...head, offset: 4097 })).toBe(false);
    expect(sameWorkUnitLogPosition(head, { ...head, ino: 23 })).toBe(false);
  });

  it('拒绝损坏 JSON、缺字段与非法 log 位置', () => {
    expect(() => parseWorkUnitCurrentManifest('{', 'manifest.json')).toThrow('manifest.json');
    expect(() => parseWorkUnitCurrentManifest(JSON.stringify({ version: 1, count: 1, log: { ...head, offset: -1 } }), 'manifest.json')).toThrow('offset');
    expect(() => parseWorkUnitCurrentManifest(JSON.stringify({ version: 2, count: 1, log: head }), 'manifest.json')).toThrow('version');
    expect(() => parseWorkUnitCurrentManifest(JSON.stringify({ version: 1, log: head }), 'manifest.json')).toThrow('count');
  });

  it('projection 必须属于目标 WU 且精确等于完整提交 head', () => {
    const projection = { version: 1, log: { ...head }, snapshot };
    expect(parseWorkUnitCurrentProjection(JSON.stringify(projection), 'wu-1', manifest, 'current.json')).toEqual(projection);
    expect(() => parseWorkUnitCurrentProjection(JSON.stringify({ ...projection, snapshot: { ...snapshot, id: 'wu-2' } }), 'wu-1', manifest, 'current.json')).toThrow('wu-1');
    expect(() => parseWorkUnitCurrentProjection(JSON.stringify({ ...projection, log: { ...head, ino: 99 } }), 'wu-1', manifest, 'current.json')).toThrow('generation');
    expect(() => parseWorkUnitCurrentProjection(JSON.stringify({ ...projection, log: { ...head, offset: 4000 } }), 'wu-1', manifest, 'current.json')).toThrow('head');
    expect(() => parseWorkUnitCurrentProjection(JSON.stringify({ ...projection, log: { ...head, offset: 5000 } }), 'wu-1', manifest, 'current.json')).toThrow('head');
  });
});
