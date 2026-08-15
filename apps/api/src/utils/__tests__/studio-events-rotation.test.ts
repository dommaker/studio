/**
 * studio-events-rotation (#173 / #60 决策 Q3b，spec 批次 C4) — 事件保留轮转
 *
 * 口诀：信号永久留（热 30 天 → 月度 gzip 冷包不删），噪声 7 天滚。
 * 信号/噪声分类口径 = #172 落地的 envelope level：level=debug（knowledge:*、tool:call）
 * 为噪声，其余（缺省 info / warning / critical）为信号；显式 level 字段优先于 type 默认分级。
 *
 * 覆盖：分类口径、噪声 7 天滚动删除、信号 30 天热 → 月度 gzip 归档（分桶/追加/幂等）、
 * 边界（无文件 / 无时间 / 损坏行保守保留）、轮转后热文件形态（原始行文本不变、暂存文件清理）。
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
  classifyStudioEventForRetention,
  rotateStudioEvents,
  NOISE_RETENTION_DAYS,
  SIGNAL_HOT_DAYS,
} from '../studio-events-rotation.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** 造一行事件（writeStudioEvent 落盘形态：payload 为 JSON string） */
function eventLine(type: string, createdAt: string, opts?: { level?: string; payload?: unknown }): string {
  return JSON.stringify({
    type,
    ...(opts?.level ? { level: opts.level } : {}),
    payload: JSON.stringify(opts?.payload ?? { probe: true }),
    createdAt,
  });
}

function readGzLines(gzFile: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(gzFile)).toString('utf-8').split('\n').filter(l => l.trim());
}

function readHotLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
}

describe('classifyStudioEventForRetention（#60 决议口径：level=debug 为噪声）', () => {
  it('knowledge:* 与 tool:call 无 level 字段 → noise（type 默认分级 debug）', () => {
    expect(classifyStudioEventForRetention({ type: 'knowledge:skill_used' })).toBe('noise');
    expect(classifyStudioEventForRetention({ type: 'knowledge:outcome' })).toBe('noise');
    expect(classifyStudioEventForRetention({ type: 'tool:call' })).toBe('noise');
  });

  it('显式 level=debug → noise（与 type 无关）', () => {
    expect(classifyStudioEventForRetention({ type: 'knowledge:skill_used', level: 'debug' })).toBe('noise');
  });

  it('缺省 info（无 level 字段）/ warning / critical → signal', () => {
    expect(classifyStudioEventForRetention({ type: 'workunit:execution_step' })).toBe('signal');
    expect(classifyStudioEventForRetention({ type: 'workunit:failed', level: 'warning' })).toBe('signal');
    expect(classifyStudioEventForRetention({ type: 'monitor:alert' })).toBe('signal');
    expect(classifyStudioEventForRetention({ type: 'session:start' })).toBe('signal');
  });

  it('显式 level 覆盖 type 默认分级（knowledge 提级为 warning → signal）', () => {
    expect(classifyStudioEventForRetention({ type: 'knowledge:outcome', level: 'warning' })).toBe('signal');
  });

  it('type 缺失/非字符串 → signal（宁可永久留，不静默丢数据）', () => {
    expect(classifyStudioEventForRetention({})).toBe('signal');
    expect(classifyStudioEventForRetention({ type: 42 })).toBe('signal');
  });
});

describe('rotateStudioEvents', () => {
  let dir: string;
  let file: string;
  let archiveDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-events-rotation-'));
    file = path.join(dir, 'studio-events.jsonl');
    archiveDir = path.join(dir, 'archive');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeHot(lines: string[]): void {
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  }

  describe('噪声 7 天滚动清理', () => {
    it(`超过 ${NOISE_RETENTION_DAYS} 天的噪声事件从热文件删除`, async () => {
      const oldNoise = eventLine('knowledge:skill_used', isoDaysAgo(NOISE_RETENTION_DAYS + 1), { level: 'debug' });
      const freshNoise = eventLine('knowledge:skill_used', isoDaysAgo(NOISE_RETENTION_DAYS - 1), { level: 'debug' });
      writeHot([oldNoise, freshNoise]);

      const result = await rotateStudioEvents({ file, now: NOW });

      expect(result.noiseDropped).toBe(1);
      expect(readHotLines(file)).toEqual([freshNoise]);
    });

    it('无 level 字段的 knowledge:*（type 默认 debug）同样 7 天滚', async () => {
      writeHot([eventLine('knowledge:skill_used', isoDaysAgo(30))]);
      const result = await rotateStudioEvents({ file, now: NOW });
      expect(result.noiseDropped).toBe(1);
      expect(readHotLines(file)).toEqual([]);
    });

    it('7 天规则不伤信号：8 天前的信号事件保留在热文件', async () => {
      const signal = eventLine('workunit:execution_step', isoDaysAgo(NOISE_RETENTION_DAYS + 1));
      writeHot([signal]);
      const result = await rotateStudioEvents({ file, now: NOW });
      expect(result.noiseDropped).toBe(0);
      expect(result.signalArchived).toBe(0);
      expect(readHotLines(file)).toEqual([signal]);
    });
  });

  describe(`信号热 ${SIGNAL_HOT_DAYS} 天 → 月度 gzip 归档（永久保留）`, () => {
    it(`超过 ${SIGNAL_HOT_DAYS} 天的信号事件移出热文件，落入当月 gz 冷包（原文保留）`, async () => {
      const oldSignal = eventLine('workunit:failed', isoDaysAgo(SIGNAL_HOT_DAYS + 1), { level: 'warning' });
      const hotSignal = eventLine('workunit:execution_step', isoDaysAgo(SIGNAL_HOT_DAYS - 1));
      writeHot([oldSignal, hotSignal]);

      const result = await rotateStudioEvents({ file, now: NOW });

      expect(result.signalArchived).toBe(1);
      expect(readHotLines(file)).toEqual([hotSignal]);
      // 31 天前 = 2026-07 月
      const gz = path.join(archiveDir, 'studio-events-2026-07.jsonl.gz');
      expect(result.archiveFiles).toEqual([gz]);
      expect(readGzLines(gz)).toEqual([oldSignal]);
    });

    it('跨月分桶：不同月份的超期信号各入各的月度 gz', async () => {
      const july = eventLine('monitor:alert', isoDaysAgo(40)); // 2026-07
      const june = eventLine('session:end', isoDaysAgo(70));   // 2026-06
      writeHot([july, june]);

      const result = await rotateStudioEvents({ file, now: NOW });

      expect(result.signalArchived).toBe(2);
      expect(readHotLines(file)).toEqual([]);
      expect(readGzLines(path.join(archiveDir, 'studio-events-2026-07.jsonl.gz'))).toEqual([july]);
      expect(readGzLines(path.join(archiveDir, 'studio-events-2026-06.jsonl.gz'))).toEqual([june]);
    });

    it('已存在的月度 gz 追加而非覆盖（冷包只增不删）', async () => {
      fs.mkdirSync(archiveDir, { recursive: true });
      const existing = eventLine('workunit:failed', isoDaysAgo(40), { level: 'warning' });
      const gz = path.join(archiveDir, 'studio-events-2026-07.jsonl.gz');
      fs.writeFileSync(gz, zlib.gzipSync(existing + '\n'));

      const newcomer = eventLine('workunit:failed', isoDaysAgo(35), { level: 'warning' });
      writeHot([newcomer]);

      await rotateStudioEvents({ file, now: NOW });

      expect(readGzLines(gz)).toEqual([existing, newcomer]);
    });

    it('幂等：连续两轮轮转不重复归档、不重复删除', async () => {
      const old = eventLine('workunit:failed', isoDaysAgo(45), { level: 'warning' });
      const noise = eventLine('tool:call', isoDaysAgo(10), { level: 'debug' });
      const hot = eventLine('workunit:execution_step', isoDaysAgo(1));
      writeHot([old, noise, hot]);

      await rotateStudioEvents({ file, now: NOW });
      const second = await rotateStudioEvents({ file, now: NOW });

      expect(second.noiseDropped).toBe(0);
      expect(second.signalArchived).toBe(0);
      expect(second.archiveFiles).toEqual([]);
      expect(readGzLines(path.join(archiveDir, 'studio-events-2026-07.jsonl.gz'))).toEqual([old]);
      expect(readHotLines(file)).toEqual([hot]);
    });
  });

  describe('边界与安全', () => {
    it('热文件不存在 → no-op（rotated=false，全零计数，不抛错）', async () => {
      const result = await rotateStudioEvents({ file, now: NOW });
      expect(result).toEqual({
        rotated: false,
        keptHot: 0,
        noiseDropped: 0,
        signalArchived: 0,
        archiveFiles: [],
      });
      expect(fs.existsSync(archiveDir)).toBe(false);
    });

    it('createdAt 缺失/非法的事件保守保留在热文件（不计龄不删除）', async () => {
      const noTime = JSON.stringify({ type: 'workunit:failed', payload: '{"a":1}' });
      const badTime = JSON.stringify({ type: 'knowledge:skill_used', level: 'debug', payload: '{"a":1}', createdAt: 'not-a-date' });
      writeHot([noTime, badTime]);

      const result = await rotateStudioEvents({ file, now: NOW });

      expect(result.noiseDropped).toBe(0);
      expect(result.signalArchived).toBe(0);
      expect(readHotLines(file)).toEqual([noTime, badTime]);
    });

    it('损坏行（非 JSON）保守保留，原始文本不变', async () => {
      const corrupt = '{"type":"workunit:failed",broken';
      writeHot([corrupt]);

      await rotateStudioEvents({ file, now: NOW });

      expect(readHotLines(file)).toEqual([corrupt]);
    });

    it('轮转后无暂存文件残留；回写保留原始行文本（不重序列化）', async () => {
      const line = eventLine('workunit:execution_step', isoDaysAgo(1));
      writeHot([line]);

      const result = await rotateStudioEvents({ file, now: NOW });

      expect(result.rotated).toBe(true);
      expect(result.keptHot).toBe(1);
      expect(readHotLines(file)).toEqual([line]); // 逐字节等于原始行
      expect(fs.readdirSync(dir).filter(n => n.includes('.rotating-'))).toEqual([]);
    });
  });
});
