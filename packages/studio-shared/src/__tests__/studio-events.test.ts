/**
 * studio-events（#361 自 apps/api 下沉后共享包侧单测）
 *
 * 重点覆盖下沉后的路径语义：
 * - 测试环境默认隔离到 os.tmpdir()/studio-test-logs/（修 runner 直写生产 logs 的缺口）
 * - STUDIO_EVENTS_FILE 整体覆盖优先
 * - 空载荷拒绝、level 缺省规则、payload 解析与时间提取
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveStudioEventsFile,
  isEmptyEventPayload,
  defaultStudioEventLevel,
  writeStudioEvent,
  readStudioEvents,
  parseStudioEventPayload,
  getStudioEventTime,
} from '../studio-events';

describe('resolveStudioEventsFile (#361 隔离语义)', () => {
  const prevFile = process.env.STUDIO_EVENTS_FILE;

  afterEach(() => {
    if (prevFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
    else process.env.STUDIO_EVENTS_FILE = prevFile;
  });

  test('STUDIO_EVENTS_FILE 覆盖优先（测试按文件隔离）', () => {
    process.env.STUDIO_EVENTS_FILE = '/tmp/custom-events.jsonl';
    expect(resolveStudioEventsFile()).toBe('/tmp/custom-events.jsonl');
  });

  test('vitest 下默认落 os.tmpdir()/studio-test-logs/，不落 ~/.studio/logs', () => {
    delete process.env.STUDIO_EVENTS_FILE;
    // vitest 进程自带 VITEST=true；不依赖该前提时显式断言 env 判定在 log-path 单测覆盖
    expect(resolveStudioEventsFile()).toBe(path.join(os.tmpdir(), 'studio-test-logs', 'studio-events.jsonl'));
    expect(resolveStudioEventsFile()).not.toContain('.studio');
  });
});

describe('writeStudioEvent', () => {
  let eventsFile: string;

  beforeEach(() => {
    eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-studio-events-')), 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(eventsFile), { recursive: true, force: true });
  });

  test('写入 StudioEvent envelope（source 可选、info 不落 level 字段）', async () => {
    const ok = await writeStudioEvent('session:start', { sessionId: 's1' }, {
      source: 'unit-test',
      file: eventsFile,
      createdAt: '2026-08-27T00:00:00.000Z',
    });
    expect(ok).toBe(true);
    const rows = readEnvelope(eventsFile);
    expect(rows).toEqual([{
      type: 'session:start',
      source: 'unit-test',
      payload: '{"sessionId":"s1"}',
      createdAt: '2026-08-27T00:00:00.000Z',
    }]);
  });

  test('knowledge:* 与 tool:call 默认 debug（level 落字段），其余缺省 info 不落字段', async () => {
    await writeStudioEvent('tool:call', { tool: 'x' }, { file: eventsFile });
    await writeStudioEvent('session:start', { sessionId: 's1' }, { file: eventsFile });
    const [toolRow, sessionRow] = readEnvelope(eventsFile);
    expect(toolRow).toMatchObject({ type: 'tool:call', level: 'debug' });
    expect(sessionRow).not.toHaveProperty('level');
    expect(defaultStudioEventLevel('knowledge:x')).toBe('debug');
    expect(defaultStudioEventLevel('session:start')).toBe('info');
  });

  test.each([
    ['空串', ''],
    ['{} 对象', {}],
    ['null', null],
    ["'null' 字符串", 'null'],
    ['空数组', []],
  ])('空 payload 拒绝落盘：%s', async (_label, payload) => {
    expect(isEmptyEventPayload(payload)).toBe(true);
    const ok = await writeStudioEvent('some:type', payload, { file: eventsFile });
    expect(ok).toBe(false);
    expect(fs.existsSync(eventsFile)).toBe(false);
  });

  test('读 API：readStudioEvents + parse/getStudioEventTime', async () => {
    await writeStudioEvent('a:type', { n: 1 }, { file: eventsFile, createdAt: '2026-08-27T01:02:03.000Z', source: 'u' });
    const events = await readStudioEvents({ file: eventsFile });
    expect(events).toHaveLength(1);
    expect(parseStudioEventPayload<{ n: number }>(events[0])).toEqual({ n: 1 });
    expect(getStudioEventTime(events[0])).toBe(new Date('2026-08-27T01:02:03.000Z').getTime());
  });

  /** 读原始 envelope 行（不经 readStudioEvents 的容错路径） */
  function readEnvelope(file: string): Array<Record<string, unknown>> {
    return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  }
});
