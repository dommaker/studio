/**
 * incident-store（#255）— incidents.jsonl append-only 存储语义测试
 *
 * 验收方向（issue #255）：写入收敛为 append-only（更新以新行表达，读方归并）；
 * 轮转窗口内不产生行复活/丢失 —— 轮转与 updateIncident 交错（注入时序）后，
 * 热文件 + archive 合集与写入全集一致。
 *
 * 只测外部行为：文件行内容、归并结果、与 rotateJsonlLog（#213）交错后的落盘形态。
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

import { FileStore } from '@dommaker/studio-shared';
import { foldIncidentRows, appendIncidentUpdate } from '../incident-store.js';
import { rotateJsonlLog } from '../../../../utils/studio-log-rotation.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function incidentRow(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, createdAt, status: 'diagnosing', ...extra };
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
}

function readJsonRows(file: string): any[] {
  return readLines(file).map(l => JSON.parse(l));
}

function readGzLines(gzFile: string): string[] {
  return zlib.gunzipSync(fs.readFileSync(gzFile)).toString('utf-8').split('\n').filter(l => l.trim());
}

let root: string;
let file: string;
let archiveDir: string;
let store: FileStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-incident-store-test-'));
  file = path.join(root, 'incidents.jsonl');
  archiveDir = path.join(root, 'archive');
  fs.mkdirSync(root, { recursive: true });
  store = new FileStore();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('foldIncidentRows（读方归并语义）', () => {
  it('同 id 多行：updatedAt 大者胜出，与行序无关', () => {
    const rows = [
      { id: 'a', createdAt: isoDaysAgo(2), updatedAt: isoDaysAgo(0.1), status: 'resolved' },
      { id: 'a', createdAt: isoDaysAgo(2), updatedAt: isoDaysAgo(1), status: 'diagnosing' },
    ];
    expect(foldIncidentRows(rows).get('a')!.status).toBe('resolved');
  });

  it('无 updatedAt 退回 createdAt 比较；全部并列 → 后行胜出', () => {
    const rows = [
      { id: 'a', createdAt: isoDaysAgo(1), status: 'v1' },
      { id: 'b', status: 'no-time-1' },
      { id: 'b', status: 'no-time-2' },
    ];
    const merged = foldIncidentRows(rows);
    expect(merged.get('a')!.status).toBe('v1');
    expect(merged.get('b')!.status).toBe('no-time-2');
  });

  it('无 id 的行跳过', () => {
    expect(foldIncidentRows([{ status: 'x' }, { id: '', status: 'y' }]).size).toBe(0);
  });
});

describe('appendIncidentUpdate（append-only 写入语义）', () => {
  it('更新以新行追加：原行字节不动，新行 = 归并后的当前行 + patch + updatedAt', async () => {
    const original = JSON.stringify(incidentRow('I-1', isoDaysAgo(1)));
    fs.writeFileSync(file, original + '\n');

    const ok = await appendIncidentUpdate(store, file, 'I-1', { status: 'resolved', resolution: 'fixed' });

    expect(ok).toBe(true);
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(original); // 原行未被重写
    const appended = JSON.parse(lines[1]);
    expect(appended).toMatchObject({ id: 'I-1', status: 'resolved', resolution: 'fixed' });
    expect(typeof appended.updatedAt).toBe('string');
  });

  it('目标 id 不存在 → no-op，文件不变', async () => {
    const original = JSON.stringify(incidentRow('I-1', isoDaysAgo(1)));
    fs.writeFileSync(file, original + '\n');

    const ok = await appendIncidentUpdate(store, file, 'I-404', { status: 'resolved' });

    expect(ok).toBe(false);
    expect(readLines(file)).toEqual([original]);
  });

  it('归并基线 = 最新行而非首行：v1+v2 同 id 后更新基于 v2', async () => {
    fs.writeFileSync(file, [
      JSON.stringify(incidentRow('I-1', isoDaysAgo(2), { status: 'diagnosing', updatedAt: isoDaysAgo(1) })),
      JSON.stringify(incidentRow('I-1', isoDaysAgo(2), { status: 'acting', updatedAt: isoDaysAgo(0.5), attempt: 2 })),
    ].join('\n') + '\n');

    await appendIncidentUpdate(store, file, 'I-1', { status: 'resolved' });

    const merged = foldIncidentRows(readJsonRows(file)).get('I-1')!;
    expect(merged).toMatchObject({ status: 'resolved', attempt: 2 });
  });
});

describe('与 #213 轮转交错（注入时序）', () => {
  it('轮转后更新：归档行不复活，热文件 + gz 合集与写入全集一致', async () => {
    const rowA = incidentRow('I-old', isoDaysAgo(40));   // 超热窗 → 归档
    const rowB = incidentRow('I-new', isoDaysAgo(1));    // 热窗内 → 幸存
    fs.writeFileSync(file, [JSON.stringify(rowA), JSON.stringify(rowB)].join('\n') + '\n');

    const result = await rotateJsonlLog({
      file,
      now: NOW,
      archiveDir,
      policies: { default: { hotDays: 30, action: 'archive' } },
    });
    expect(result.archived).toBe(1);
    expect(result.keptHot).toBe(1);

    const ok = await appendIncidentUpdate(store, file, 'I-new', { status: 'resolved' });
    expect(ok).toBe(true);

    // 热文件无复活行：只有幸存行 B + 新行 B'
    const hotIds = readJsonRows(file).map(r => r.id);
    expect(hotIds).toEqual(['I-new', 'I-new']);
    expect(readJsonRows(file).some(r => r.id === 'I-old')).toBe(false);
    // gz 归档恰好一行 A，未被二次写入污染
    const gzFile = path.join(archiveDir, 'incidents-2026-07.jsonl.gz');
    expect(readGzLines(gzFile)).toHaveLength(1);
    expect(JSON.parse(readGzLines(gzFile)[0]).id).toBe('I-old');
    // 合集与写入全集一致：{A, B, B'} 无重复无丢失
    const allRows = [...readGzLines(gzFile).map(l => JSON.parse(l)), ...readJsonRows(file)];
    expect(allRows).toHaveLength(3);
    expect(foldIncidentRows(allRows).get('I-new')!.status).toBe('resolved');
  });

  it('轮转窗口内更新：不触碰 rotating 暂存文件，回写后更新正常叠加不覆盖幸存行', async () => {
    const rowA = incidentRow('I-old', isoDaysAgo(40));
    const rowB = incidentRow('I-new', isoDaysAgo(1));
    fs.writeFileSync(file, [JSON.stringify(rowA), JSON.stringify(rowB)].join('\n') + '\n');

    // 注入时序 —— 轮转第 1 步：rename 热文件 → 暂存（处理窗口打开）
    const rotating = `${file}.rotating-test`;
    fs.renameSync(file, rotating);
    const rotatingBefore = fs.readFileSync(rotating, 'utf-8');

    // 窗口内更新：热文件不可见 → no-op，且暂存文件字节不动（无复活/覆盖）
    const okInWindow = await appendIncidentUpdate(store, file, 'I-new', { status: 'resolved' });
    expect(okInWindow).toBe(false);
    expect(fs.readFileSync(rotating, 'utf-8')).toBe(rotatingBefore);

    // 注入时序 —— 轮转第 2 步：幸存者 append 回热文件，删暂存
    fs.writeFileSync(file, JSON.stringify(rowB) + '\n');
    fs.unlinkSync(rotating);

    // 窗口后更新：基于回写的幸存行追加新行，幸存行保留在文件中（旧覆写实现会丢）
    const okAfter = await appendIncidentUpdate(store, file, 'I-new', { status: 'resolved' });
    expect(okAfter).toBe(true);
    expect(readLines(file)).toHaveLength(2);
    expect(foldIncidentRows(readJsonRows(file)).get('I-new')!.status).toBe('resolved');
  });

  it('窗口后回写行序晚于新行（B\' 先、B 后）时，归并仍取新状态', async () => {
    // 极端交错：更新先落新热文件，轮转随后把幸存旧行 append 回写 → 旧行行序在后
    fs.writeFileSync(file, JSON.stringify(incidentRow('I-new', isoDaysAgo(1))) + '\n');
    await appendIncidentUpdate(store, file, 'I-new', { status: 'resolved' });
    // 模拟轮转回写把旧行追加到新行之后
    fs.appendFileSync(file, JSON.stringify(incidentRow('I-new', isoDaysAgo(1))) + '\n');

    // rank（updatedAt）决胜，不被行序翻盘
    expect(foldIncidentRows(readJsonRows(file)).get('I-new')!.status).toBe('resolved');
  });
});
