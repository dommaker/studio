/**
 * #521 离线对齐工具命令行壳测试：参数解析（相对/绝对时间窗、traceId、数据根覆盖）
 * 与数据加载（合成 tmp studio-home；缺目录/缺文件优雅降级为空数据源 + 数据提示）。
 * 壳的报表渲染不逐字断言（spec：命令行壳不测——此处只锁参数与读口契约）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, loadInput } from '../mainline-align.js';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');

describe('parseArgs', () => {
  it('相对时间窗（24h/7d/30m）换算为 sinceMs', () => {
    expect(parseArgs(['--since', '24h'], NOW).sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(parseArgs(['--since', '7d'], NOW).sinceMs).toBe(NOW - 7 * 86_400_000);
    expect(parseArgs(['--since', '30m'], NOW).sinceMs).toBe(NOW - 30 * 60_000);
  });

  it('ISO 时间与 --until；缺省无窗', () => {
    const a = parseArgs(['--since', '2026-09-11T00:00:00Z', '--until', '2026-09-12T00:00:00Z'], NOW);
    expect(a.sinceMs).toBe(Date.parse('2026-09-11T00:00:00Z'));
    expect(a.untilMs).toBe(Date.parse('2026-09-12T00:00:00Z'));
    const none = parseArgs([], NOW);
    expect(none.sinceMs).toBeNull();
    expect(none.untilMs).toBeNull();
  });

  it('非法时间值 → null（按无窗处理，不抛错）', () => {
    expect(parseArgs(['--since', 'not-a-time'], NOW).sinceMs).toBeNull();
  });

  it('--traceId 与 --studio-home/--events-file 覆盖', () => {
    const a = parseArgs(['--traceId', 'trace-x', '--studio-home', '/tmp/sh', '--events-file', '/tmp/ev.jsonl'], NOW);
    expect(a.traceId).toBe('trace-x');
    expect(a.studioHome).toBe('/tmp/sh');
    expect(a.eventsFile).toBe('/tmp/ev.jsonl');
  });
});

describe('loadInput', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-align-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const args = (over: Partial<ReturnType<typeof parseArgs>> = {}) => ({
    sinceMs: null, untilMs: null, traceId: null, studioHome: home, eventsFile: null, ...over,
  });

  it('读取三家数据源：频道消息热文件 / WU 快照 / 事件流；损坏行跳过', () => {
    const chDir = path.join(home, 'data', 'channels', 'ch1');
    fs.mkdirSync(chDir, { recursive: true });
    fs.writeFileSync(path.join(chDir, 'messages.jsonl'), [
      JSON.stringify({ id: 'm1', channelId: 'ch1', authorType: 'human', createdAt: '2026-09-12T10:00:00Z' }),
      '{bad-line',
      JSON.stringify({ id: 'm2', channelId: 'ch1', authorType: 'agent', workUnitId: 'wu1', createdAt: '2026-09-12T10:01:00Z' }),
    ].join('\n'));
    fs.mkdirSync(path.join(home, 'data', 'workunits'), { recursive: true });
    fs.writeFileSync(path.join(home, 'data', 'workunits', 'index.json'), JSON.stringify([
      { id: 'wu1', channelId: 'ch1', createdAt: '2026-09-12T10:00:02Z' },
    ]));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'studio-events.jsonl'), JSON.stringify({
      type: 'workunit:execution_step', payload: '{"workUnitId":"wu1","step":1,"at":"2026-09-12T10:00:30Z"}', createdAt: '2026-09-12T10:00:30Z',
    }) + '\n');

    const input = loadInput(args());
    expect(input.messages).toHaveLength(2); // 损坏行跳过
    expect(input.workunits).toHaveLength(1);
    expect(input.events).toHaveLength(1);
    expect(input.dataNotes).toEqual([]);
  });

  it('目录/文件缺失 → 空数据源 + 数据提示，不抛错', () => {
    const input = loadInput(args({ studioHome: path.join(home, 'missing') }));
    expect(input.messages).toEqual([]);
    expect(input.workunits).toEqual([]);
    expect(input.events).toEqual([]);
    expect(input.dataNotes.length).toBeGreaterThanOrEqual(3);
  });
});
