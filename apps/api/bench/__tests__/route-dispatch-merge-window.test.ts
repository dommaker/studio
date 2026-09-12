// #507 bench 脚本纯函数单测：tailScanHuman / tailScanFirstHumanWu / stats
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tailScanHuman, tailScanFirstHumanWu, stats } from '../route-dispatch-merge-window.js';

let tmpDir = '';
let file = '';

function row(id: string, authorType: string, workUnitId: string | null = null) {
  return JSON.stringify({ id, channelId: 'c1', authorType, agentName: null, content: 'x', replyToId: null, meta: '{}', workUnitId, createdAt: '2026-09-12T00:00:00.000Z' });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-dispatch-bench-test-'));
  file = path.join(tmpDir, 'messages.jsonl');
  // 8 行：agent 多数；human 两条（h1 无 wu、h2 带 wu）；尾部 agent 收尾
  const lines = [
    row('a1', 'agent'),
    row('h1', 'human'),
    row('a2', 'agent'),
    row('h2', 'human', 'wu-1'),
    row('a3', 'agent'),
    row('a4', 'agent'),
    // 更新副本：h1 的 meta 更新 append 在尾（createdAt 不变，#317 形态）
    row('h1', 'human'),
    row('a5', 'agent'),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tailScanHuman', () => {
  it('倒扫去重收集 human，凑满 need 即停', async () => {
    const res = await tailScanHuman(file, 2);
    // h1 计一次（尾部副本先见、原行被去重）+ h2 = 2 条即停
    expect(res.count).toBe(2);
    expect(res.scanned).toBeLessThan(8);
  });

  it('need 超过总数时扫到文件头', async () => {
    const res = await tailScanHuman(file, 20);
    expect(res.count).toBe(2);
    expect(res.scanned).toBe(8);
  });
});

describe('tailScanFirstHumanWu', () => {
  it('遇第一条去重后 human+workUnitId 即停', async () => {
    const res = await tailScanFirstHumanWu(file);
    expect(res.found).toBe(true);
    // 从尾部 a5 → h1副本 → a4 → a3 → h2 命中 = 5 行
    expect(res.scanned).toBe(5);
  });

  it('无 human+workUnitId 时扫全文件返回 false', async () => {
    const empty = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(empty, [row('a1', 'agent'), row('h9', 'human')].join('\n') + '\n');
    const res = await tailScanFirstHumanWu(empty);
    expect(res.found).toBe(false);
    expect(res.scanned).toBe(2);
  });
});

describe('stats', () => {
  it('min/median/p95/mean 基本口径', () => {
    const r = stats([1, 2, 3, 4, 10]);
    expect(r.min).toBe(1);
    expect(r.median).toBe(3);
    expect(r.mean).toBe(4);
    expect(r.p95).toBeGreaterThanOrEqual(r.median);
  });
});
