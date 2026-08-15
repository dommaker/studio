/**
 * studio-events (D18) — 统一事件写入/读取入口
 *
 * 覆盖：路径解析（测试隔离）、空 payload 拒收、正常写入形态、
 * 读 API、payload 解析、事件时间兼容（createdAt / timestamp）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { logger } from '@dommaker/studio-shared';
import {
  resolveStudioEventsFile,
  isEmptyEventPayload,
  writeStudioEvent,
  readStudioEvents,
  parseStudioEventPayload,
  getStudioEventTime,
  defaultStudioEventLevel,
} from '../studio-events.js';

describe('resolveStudioEventsFile', () => {
  it('vitest 环境 → 隔离目录下的 studio-events.jsonl', () => {
    expect(resolveStudioEventsFile())
      .toBe(path.join(os.tmpdir(), 'studio-test-logs', 'studio-events.jsonl'));
  });

  it('STUDIO_EVENTS_FILE 覆盖优先（测试按文件隔离）', () => {
    const prev = process.env.STUDIO_EVENTS_FILE;
    process.env.STUDIO_EVENTS_FILE = '/tmp/custom-events.jsonl';
    try {
      expect(resolveStudioEventsFile()).toBe('/tmp/custom-events.jsonl');
    } finally {
      if (prev === undefined) delete process.env.STUDIO_EVENTS_FILE;
      else process.env.STUDIO_EVENTS_FILE = prev;
    }
  });
});

describe('isEmptyEventPayload', () => {
  it('{} / null / undefined / 空串 / "{}" / "null" / 空数组 → 空', () => {
    expect(isEmptyEventPayload({})).toBe(true);
    expect(isEmptyEventPayload(null)).toBe(true);
    expect(isEmptyEventPayload(undefined)).toBe(true);
    expect(isEmptyEventPayload('')).toBe(true);
    expect(isEmptyEventPayload('  ')).toBe(true);
    expect(isEmptyEventPayload('{}')).toBe(true);
    expect(isEmptyEventPayload('null')).toBe(true);
    expect(isEmptyEventPayload([])).toBe(true);
  });

  it('有字段对象 / 非空数组 / 非 JSON 字符串 / 数字 → 非空', () => {
    expect(isEmptyEventPayload({ a: 1 })).toBe(false);
    expect(isEmptyEventPayload('{"a":1}')).toBe(false);
    expect(isEmptyEventPayload([1])).toBe(false);
    expect(isEmptyEventPayload('plain text')).toBe(false);
    expect(isEmptyEventPayload(0)).toBe(false);
    expect(isEmptyEventPayload(false)).toBe(false);
  });
});

describe('writeStudioEvent + readStudioEvents', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-events-test-'));
    file = path.join(dir, 'studio-events.jsonl');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正常事件落盘为 StudioEvent 形态（type/source/payload JSON string/createdAt）', async () => {
    const ok = await writeStudioEvent('monitor:alert', { level: 'warning', message: 'm' }, { source: 'monitor', file });
    expect(ok).toBe(true);

    const rows = await readStudioEvents({ file });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('monitor:alert');
    expect(rows[0].source).toBe('monitor');
    expect(typeof rows[0].payload).toBe('string');
    expect(JSON.parse(rows[0].payload as string)).toEqual({ level: 'warning', message: 'm' });
    expect(typeof rows[0].createdAt).toBe('string');
  });

  it('payload 已是 JSON string 时原样写入（不二次序列化）', async () => {
    await writeStudioEvent('knowledge:consumption', '{"entryIds":["k1"],"count":1}', { file });
    const rows = await readStudioEvents({ file });
    expect(rows[0].payload).toBe('{"entryIds":["k1"],"count":1}');
  });

  it.each([
    ['{} 对象', {}],
    ['null', null],
    ['undefined', undefined],
    ['"{}" 字符串', '{}'],
    ['空串', ''],
  ])('空 payload（%s）拒绝落盘并 logger.warn', async (_label, payload) => {
    const ok = await writeStudioEvent('knowledge:consumption', payload, { source: 'test', file });
    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('empty-payload'),
      expect.objectContaining({ type: 'knowledge:consumption', source: 'test' }),
    );
    expect(fs.existsSync(file)).toBe(false); // 一行都不写
  });

  it('type 缺失拒绝落盘', async () => {
    const ok = await writeStudioEvent('', { a: 1 }, { file });
    expect(ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件不存在时 readStudioEvents 返回 []（不抛出）', async () => {
    await expect(readStudioEvents({ file: path.join(dir, 'none.jsonl') })).resolves.toEqual([]);
  });
});

describe('parseStudioEventPayload', () => {
  it('JSON string → object；object 原样；损坏 → null', () => {
    expect(parseStudioEventPayload({ payload: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseStudioEventPayload({ payload: { a: 1 } })).toEqual({ a: 1 });
    expect(parseStudioEventPayload({ payload: '{broken' })).toBeNull();
    expect(parseStudioEventPayload({})).toBeNull();
  });
});

describe('getStudioEventTime', () => {
  it('createdAt（ISO）优先', () => {
    expect(getStudioEventTime({ createdAt: '2026-07-27T00:00:00.000Z' }))
      .toBe(new Date('2026-07-27T00:00:00.000Z').getTime());
  });

  it('兼容历史扁平事件 timestamp（ISO string / epoch number）', () => {
    expect(getStudioEventTime({ timestamp: '2026-07-27T00:00:00.000Z' }))
      .toBe(new Date('2026-07-27T00:00:00.000Z').getTime());
    expect(getStudioEventTime({ timestamp: 1784569545576 })).toBe(1784569545576);
  });

  it('缺失/非法 → NaN', () => {
    expect(Number.isNaN(getStudioEventTime({}))).toBe(true);
    expect(Number.isNaN(getStudioEventTime({ createdAt: 'not-a-date' }))).toBe(true);
  });
});

describe('event level（#172 / #60 决策：envelope 可选 level 字段）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-events-level-'));
    file = path.join(dir, 'studio-events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认分级：knowledge:* 与 tool:call → debug；其余 → info', () => {
    expect(defaultStudioEventLevel('knowledge:skill_used')).toBe('debug');
    expect(defaultStudioEventLevel('knowledge:outcome')).toBe('debug');
    expect(defaultStudioEventLevel('tool:call')).toBe('debug');
    expect(defaultStudioEventLevel('workunit:execution_step')).toBe('info');
    expect(defaultStudioEventLevel('workunit:failed')).toBe('info'); // 由调用方显式传 warning
    expect(defaultStudioEventLevel('monitor:alert')).toBe('info'); // 维持现有分级（payload.level）
  });

  it('debug 级事件落盘带 level 字段；缺省 info 不落字段（可选字段，缺省即 info）', async () => {
    await writeStudioEvent('knowledge:skill_used', { skillName: 'x' }, { source: 'skill-loader', file });
    await writeStudioEvent('workunit:execution_step', { workUnitId: 'w' }, { file });
    const rows = await readStudioEvents({ file });
    expect(rows[0].level).toBe('debug');
    expect(rows[1]).not.toHaveProperty('level');
  });

  it('显式 opts.level 覆盖默认分级（含把 knowledge:* 提级）', async () => {
    await writeStudioEvent('workunit:failed', { workUnitId: 'w' }, { source: 'agent-loop', level: 'warning', file });
    await writeStudioEvent('knowledge:outcome', { a: 1 }, { level: 'critical', file });
    const rows = await readStudioEvents({ file });
    expect(rows[0].level).toBe('warning');
    expect(rows[1].level).toBe('critical');
  });
});
