/**
 * output-capture 单元测试 — #174: session:start/end 事件补 workUnitId + transcript 路径
 *
 * #361：emit 全部经 studio-shared 的 writeStudioEvent 唯一入口落盘（StudioEvent
 * envelope）。写口内部 FileStore 是共享包相对导入，包级 mock 拦不到 —— 故本文件
 * 改用 STUDIO_EVENTS_FILE 指向 tmp 隔离文件、走真实写口断言磁盘行，顺带覆盖
 * 「runner 事件按 env 隔离、不落生产 logs」的 AC。
 * - 带 extras：payload 并入 workUnitId / transcriptPath（undefined 的不带键）
 * - 不带 extras：payload 无这两个键（行为不变）
 */

import { describe, test, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const eventsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'output-capture-')), 'events.jsonl');
process.env.STUDIO_EVENTS_FILE = eventsFile;
afterAll(() => {
  fs.rmSync(path.dirname(eventsFile), { recursive: true, force: true });
  delete process.env.STUDIO_EVENTS_FILE;
});

import { emitSessionStart, emitSessionEnd, emitToolCall } from '../output-capture.js';

/** 读隔离事件文件最后一条 envelope 行；解析 payload 供旧断言复用 */
function lastRow(): Record<string, unknown> {
  const rows = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  return rows[rows.length - 1];
}
function lastPayload(): Record<string, unknown> {
  return JSON.parse(lastRow().payload);
}

describe('emitSessionStart (#174)', () => {
  test('无 extras：payload 仅含既有四键', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1);
    const payload = lastPayload();
    expect(payload).toEqual({ sessionId: 'sess-1', agentId: 'exec-1', executionId: 'exec-1', sessionCount: 1 });
    expect(payload).not.toHaveProperty('workUnitId');
    expect(payload).not.toHaveProperty('transcriptPath');
  });

  test('带 extras：payload 并入 workUnitId + transcriptPath，既有字段不变', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1, {
      workUnitId: 'wu-42',
      transcriptPath: '/data/transcripts/wu-42.jsonl',
    });
    const payload = lastPayload();
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.sessionCount).toBe(1);
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload.transcriptPath).toBe('/data/transcripts/wu-42.jsonl');
  });

  test('extras 部分字段为 undefined：对应键不出现', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1, { workUnitId: 'wu-42' });
    const payload = lastPayload();
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload).not.toHaveProperty('transcriptPath');
  });
});

describe('emitSessionEnd (#174)', () => {
  test('无 extras：payload 无 workUnitId/transcriptPath 键', async () => {
    await emitSessionEnd('sess-1', 'exec-1', 2);
    const payload = lastPayload();
    expect(payload).toEqual({ sessionId: 'sess-1', agentId: 'exec-1', executionId: 'exec-1', sessionCount: 2 });
  });

  test('带 extras：payload 并入两字段', async () => {
    await emitSessionEnd('sess-1', 'exec-1', 2, {
      workUnitId: 'wu-42',
      transcriptPath: '/data/transcripts/wu-42.jsonl',
    });
    const payload = lastPayload();
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload.transcriptPath).toBe('/data/transcripts/wu-42.jsonl');
  });
});

describe('#361 事件统一入口', () => {
  test('emit 经 writeStudioEvent 落 StudioEvent envelope（无自抄扁平字段；tool:call 由写口赋 debug 级）', async () => {
    await emitToolCall('Bash', { command: 'ls' }, 'sess-1', 'exec-1');
    const row = lastRow();

    // envelope 形态：type/source/payload/createdAt + 写口按 type 赋级；
    // 旧的模块级直连写法无 level 字段且把 executionId 平铺在顶层
    expect(row.type).toBe('tool:call');
    expect(row.source).toBe('agent-executor');
    expect(row.level).toBe('debug');
    expect(typeof row.createdAt).toBe('string');
    expect(row).not.toHaveProperty('executionId');
    expect(JSON.parse(row.payload)).toEqual({
      tool: 'Bash',
      input: { command: 'ls' },
      sessionId: 'sess-1',
      executionId: 'exec-1',
    });
  });
});
