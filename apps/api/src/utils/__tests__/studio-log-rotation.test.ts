/**
 * studio-log-rotation（#213）— 泛化 jsonl 保留轮转 + 遗留日志一次性归档清理
 *
 * 决议（2026-08-19 grilling 定案，issue #213 评论）：
 * - incidents.jsonl（信号）：热 30 天 → 月度 gzip 归档只增不删
 * - audit.jsonl（审计）：热 90 天 → 月度 gzip 归档只增不删
 * - notifications.jsonl（噪声）：7 天滚动删除，不留归档
 * - tasks-YYYY-MM-DD.jsonl 一族 + 残留 ~/.studio/events/incidents.jsonl：
 *   一次性 gzip 归档后删除
 *
 * 机制复用 #173 同构实现泛化为配置驱动（rotateJsonlLog）；#173 的 studio-events
 * 轮转行为由 studio-events-rotation.test.ts 16 例继续锁定。
 *
 * 只测外部行为：轮转后热文件内容、archive 产物、删除动作、幂等性。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import {
  rotateJsonlLog,
  rotateStudioLogFiles,
  archiveLegacyStudioLogs,
  STUDIO_LOG_FILE_POLICIES,
} from '../studio-log-rotation.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function jsonlLine(createdAt: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: `x-${createdAt}`, createdAt, ...extra });
}

function readGzLines(gzFile: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(gzFile)).toString('utf-8').split('\n').filter(l => l.trim());
}

function readHotLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
}

let root: string;
let logsDir: string;
let archiveDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-log-rotation-test-'));
  logsDir = path.join(root, 'logs');
  archiveDir = path.join(logsDir, 'archive');
  fs.mkdirSync(logsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('rotateJsonlLog（泛化轮转核心，#173 同构机制配置化）', () => {
  it('热窗内行保留，超期行按 action=archive 进月度 gz（文件名取热文件 basename）', async () => {
    const file = path.join(logsDir, 'incidents.jsonl');
    fs.writeFileSync(file, [jsonlLine(isoDaysAgo(31)), jsonlLine(isoDaysAgo(5))].join('\n') + '\n');
    const result = await rotateJsonlLog({
      file,
      now: NOW,
      policies: { default: { hotDays: 30, action: 'archive' } },
    });
    expect(result.rotated).toBe(true);
    expect(result.archived).toBe(1);
    expect(result.keptHot).toBe(1);
    // 超期行 → archive/incidents-<事件月份>.jsonl.gz
    const month = isoDaysAgo(31).slice(0, 7);
    const gzFile = path.join(archiveDir, `incidents-${month}.jsonl.gz`);
    expect(readGzLines(gzFile)).toEqual([jsonlLine(isoDaysAgo(31))]);
    // 热文件只剩热窗内行
    expect(readHotLines(file)).toEqual([jsonlLine(isoDaysAgo(5))]);
    // 暂存文件清理
    expect(fs.readdirSync(logsDir).filter(f => f.includes('.rotating-'))).toEqual([]);
  });

  it('action=drop：超期行滚动删除且不进归档', async () => {
    const file = path.join(logsDir, 'notifications.jsonl');
    fs.writeFileSync(file, [jsonlLine(isoDaysAgo(8)), jsonlLine(isoDaysAgo(2))].join('\n') + '\n');
    const result = await rotateJsonlLog({
      file,
      now: NOW,
      policies: { default: { hotDays: 7, action: 'drop' } },
    });
    expect(result.dropped).toBe(1);
    expect(result.archived).toBe(0);
    expect(readHotLines(file)).toEqual([jsonlLine(isoDaysAgo(2))]);
    expect(fs.existsSync(archiveDir)).toBe(false);
  });

  it('classify 多策略分桶：不同类别各行其政', async () => {
    const file = path.join(logsDir, 'mixed.jsonl');
    const lines = [
      jsonlLine(isoDaysAgo(40), { kind: 'keep-long' }),
      jsonlLine(isoDaysAgo(40), { kind: 'drop-fast' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const result = await rotateJsonlLog({
      file,
      now: NOW,
      classify: (rec) => String(rec.kind),
      policies: {
        'keep-long': { hotDays: 90, action: 'archive' },
        'drop-fast': { hotDays: 7, action: 'drop' },
      },
    });
    expect(result.dropped).toBe(1);
    expect(result.archived).toBe(0);
    expect(readHotLines(file)).toEqual([lines[0]]);
  });

  it('损坏行 / 无时间行保守保留在热文件；热文件不存在 → no-op', async () => {
    const missing = await rotateJsonlLog({
      file: path.join(logsDir, 'nope.jsonl'),
      now: NOW,
      policies: { default: { hotDays: 30, action: 'archive' } },
    });
    expect(missing.rotated).toBe(false);

    const file = path.join(logsDir, 'incidents.jsonl');
    fs.writeFileSync(file, ['not-json{{{', jsonlLine(isoDaysAgo(60)), '{"noTime":true}'].join('\n') + '\n');
    const result = await rotateJsonlLog({
      file,
      now: NOW,
      policies: { default: { hotDays: 30, action: 'archive' } },
    });
    expect(result.archived).toBe(1);
    const hot = readHotLines(file);
    expect(hot).toContain('not-json{{{');
    expect(hot).toContain('{"noTime":true}');
  });

  it('归档只增不删：已有月度 gz 追加合并，幂等重跑不重复归档', async () => {
    const file = path.join(logsDir, 'incidents.jsonl');
    fs.writeFileSync(file, jsonlLine(isoDaysAgo(31)) + '\n');
    await rotateJsonlLog({ file, now: NOW, policies: { default: { hotDays: 30, action: 'archive' } } });
    const month = isoDaysAgo(31).slice(0, 7);
    const gzFile = path.join(archiveDir, `incidents-${month}.jsonl.gz`);
    expect(readGzLines(gzFile)).toHaveLength(1);
    // 同月再来一条超期行 → 追加进同一 gz
    fs.writeFileSync(file, jsonlLine(isoDaysAgo(40)) + '\n');
    await rotateJsonlLog({ file, now: NOW, policies: { default: { hotDays: 30, action: 'archive' } } });
    expect(readGzLines(gzFile)).toHaveLength(2);
    // 幂等：热文件无超期行时 gz 不变
    await rotateJsonlLog({ file, now: NOW, policies: { default: { hotDays: 30, action: 'archive' } } });
    expect(readGzLines(gzFile)).toHaveLength(2);
  });
});

describe('rotateStudioLogFiles（#213 决议值：incidents 30d / audit 90d / notifications 7d）', () => {
  it('决议配置锁定：三文件的分类与热窗', () => {
    const byName = Object.fromEntries(STUDIO_LOG_FILE_POLICIES.map(p => [p.fileName, p.policy]));
    expect(byName['incidents.jsonl']).toEqual({ hotDays: 30, action: 'archive' });
    expect(byName['audit.jsonl']).toEqual({ hotDays: 90, action: 'archive' });
    expect(byName['notifications.jsonl']).toEqual({ hotDays: 7, action: 'drop' });
  });

  it('incidents 31 天行归档、audit 91 天行归档而 89 天行留热、notifications 8 天行删除', async () => {
    fs.writeFileSync(path.join(logsDir, 'incidents.jsonl'),
      [jsonlLine(isoDaysAgo(31)), jsonlLine(isoDaysAgo(10))].join('\n') + '\n');
    fs.writeFileSync(path.join(logsDir, 'audit.jsonl'),
      [jsonlLine(isoDaysAgo(91)), jsonlLine(isoDaysAgo(89))].join('\n') + '\n');
    fs.writeFileSync(path.join(logsDir, 'notifications.jsonl'),
      [jsonlLine(isoDaysAgo(8)), jsonlLine(isoDaysAgo(1))].join('\n') + '\n');

    await rotateStudioLogFiles({ logsDir, now: NOW });

    expect(readGzLines(path.join(archiveDir, `incidents-${isoDaysAgo(31).slice(0, 7)}.jsonl.gz`)))
      .toEqual([jsonlLine(isoDaysAgo(31))]);
    expect(readHotLines(path.join(logsDir, 'incidents.jsonl'))).toEqual([jsonlLine(isoDaysAgo(10))]);

    expect(readGzLines(path.join(archiveDir, `audit-${isoDaysAgo(91).slice(0, 7)}.jsonl.gz`)))
      .toEqual([jsonlLine(isoDaysAgo(91))]);
    expect(readHotLines(path.join(logsDir, 'audit.jsonl'))).toEqual([jsonlLine(isoDaysAgo(89))]);

    expect(readHotLines(path.join(logsDir, 'notifications.jsonl'))).toEqual([jsonlLine(isoDaysAgo(1))]);
    expect(fs.existsSync(path.join(archiveDir, 'notifications-2026-08.jsonl.gz'))).toBe(false);
  });

  it('文件不存在 → 该文件 no-op，不影响其余文件', async () => {
    fs.writeFileSync(path.join(logsDir, 'notifications.jsonl'), jsonlLine(isoDaysAgo(9)) + '\n');
    const results = await rotateStudioLogFiles({ logsDir, now: NOW });
    expect(results).toHaveLength(3);
    expect(readHotLines(path.join(logsDir, 'notifications.jsonl'))).toEqual([]);
  });

  it('无参调用（index.ts 生产挂载形态）不抛错，走默认路径解析', async () => {
    // vitest 下 resolveStudioLogsDir() → os.tmpdir()/studio-test-logs（studio-log-path 约定）。
    // 用真实当前时间造一条 10 天前通知，无参调用后应被滚删。
    const sharedDir = path.join(os.tmpdir(), 'studio-test-logs');
    fs.mkdirSync(sharedDir, { recursive: true });
    const notifFile = path.join(sharedDir, 'notifications.jsonl');
    const marker = jsonlLine(new Date(Date.now() - 10 * DAY_MS).toISOString(), { probe: 'no-arg-213' });
    fs.writeFileSync(notifFile, marker + '\n');
    try {
      const results = await rotateStudioLogFiles();
      expect(results).toHaveLength(3);
      expect(readHotLines(notifFile)).not.toContain(marker);
    } finally {
      fs.rmSync(notifFile, { force: true });
    }
  });
});

describe('archiveLegacyStudioLogs（#213：tasks-* 一族 + 残留 incidents 一次性归档后删除）', () => {
  it('tasks-*.jsonl 全部并入 archive/tasks-legacy.jsonl.gz 后删除原文件', async () => {
    const t1 = path.join(logsDir, 'tasks-2026-05-08.jsonl');
    const t2 = path.join(logsDir, 'tasks-2026-07-31.jsonl');
    fs.writeFileSync(t1, '{"task":1}\n{"task":2}\n');
    fs.writeFileSync(t2, '{"task":3}\n');
    // 活文件不受影响
    fs.writeFileSync(path.join(logsDir, 'incidents.jsonl'), jsonlLine(isoDaysAgo(1)) + '\n');

    const result = await archiveLegacyStudioLogs({ logsDir, residualFiles: [] });

    expect(result.deleted.sort()).toEqual([t1, t2].sort());
    expect(fs.existsSync(t1)).toBe(false);
    expect(fs.existsSync(t2)).toBe(false);
    expect(readGzLines(path.join(archiveDir, 'tasks-legacy.jsonl.gz')))
      .toEqual(['{"task":1}', '{"task":2}', '{"task":3}']);
    expect(fs.existsSync(path.join(logsDir, 'incidents.jsonl'))).toBe(true);
  });

  it('残留 incidents 路径并入 archive/incidents-legacy.jsonl.gz 后删除', async () => {
    const residual = path.join(root, 'events', 'incidents.jsonl');
    fs.mkdirSync(path.dirname(residual), { recursive: true });
    fs.writeFileSync(residual, '{"old":true}\n');

    const result = await archiveLegacyStudioLogs({ logsDir, residualFiles: [residual] });

    expect(result.deleted).toEqual([residual]);
    expect(fs.existsSync(residual)).toBe(false);
    expect(readGzLines(path.join(archiveDir, 'incidents-legacy.jsonl.gz'))).toEqual(['{"old":true}']);
  });

  it('幂等：无可清理文件 → no-op；归档包只增不删可跨轮追加', async () => {
    const empty = await archiveLegacyStudioLogs({ logsDir, residualFiles: [] });
    expect(empty.deleted).toEqual([]);
    expect(empty.archiveFiles).toEqual([]);
    expect(fs.existsSync(archiveDir)).toBe(false);

    fs.writeFileSync(path.join(logsDir, 'tasks-2026-05-08.jsonl'), '{"a":1}\n');
    await archiveLegacyStudioLogs({ logsDir, residualFiles: [] });
    fs.writeFileSync(path.join(logsDir, 'tasks-2026-06-01.jsonl'), '{"b":2}\n');
    await archiveLegacyStudioLogs({ logsDir, residualFiles: [] });
    expect(readGzLines(path.join(archiveDir, 'tasks-legacy.jsonl.gz')))
      .toEqual(['{"a":1}', '{"b":2}']);
  });

  it('无参调用（生产挂载形态）不抛错；测试期默认残留路径指向隔离目录', async () => {
    // vitest 下默认残留路径 = os.tmpdir()/studio-test-logs/events/incidents.jsonl，
    // 不会触碰真实 ~/.studio（防误删生产残留文件的保险）。
    const sharedDir = path.join(os.tmpdir(), 'studio-test-logs');
    const residual = path.join(sharedDir, 'events', 'incidents.jsonl');
    fs.mkdirSync(path.dirname(residual), { recursive: true });
    fs.writeFileSync(residual, '{"legacy":true}\n');
    try {
      const result = await archiveLegacyStudioLogs();
      expect(result.deleted).toContain(residual);
      expect(fs.existsSync(residual)).toBe(false);
      expect(readGzLines(path.join(sharedDir, 'archive', 'incidents-legacy.jsonl.gz')))
        .toContain('{"legacy":true}');
    } finally {
      fs.rmSync(path.join(sharedDir, 'events'), { recursive: true, force: true });
      fs.rmSync(path.join(sharedDir, 'archive', 'incidents-legacy.jsonl.gz'), { force: true });
    }
  });
});
