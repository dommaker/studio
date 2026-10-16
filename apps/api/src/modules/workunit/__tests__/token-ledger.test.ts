/**
 * #320 token 账本（token ledger）— workunit:tokens 事件流的写侧累计派生索引。
 *
 * 验证 grilling 定稿的核心契约：事件流仍是唯一真源；账本可重建；
 * watermark（lines+bytes）自愈（落后增量补扫 / 轮转重建 / 不存在即懒回填）；
 * 新鲜时 O(1)（stat 相等直接返回，不重写账本文件）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  resolveTokenLedgerFile,
  syncTokenLedger,
  noteTokenLedgerWritten,
  emptyTokenLedger,
  type TokenLedger,
} from '../token-ledger.js';

let dir: string;
let eventsFile: string;
let ledgerFile: string;

function appendEvent(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.appendFileSync(eventsFile, JSON.stringify(row) + '\n', 'utf-8');
}

function tokenEvent(workUnitId: string, payload: Record<string, unknown>, createdAt?: string): Record<string, unknown> {
  return {
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({ workUnitId, ...payload }),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

function readLedgerFile(): TokenLedger {
  return JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')) as TokenLedger;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-'));
  eventsFile = path.join(dir, 'studio-events.jsonl');
  ledgerFile = resolveTokenLedgerFile(eventsFile);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#320 token 账本', () => {
  it('事件文件不存在 → 空账本，不落账本文件（懒回填语义，等价 watermark=0）', async () => {
    const ledger = await syncTokenLedger(eventsFile);
    expect(ledger).toEqual(emptyTokenLedger());
    expect(fs.existsSync(ledgerFile)).toBe(false);
  });

  it('账本落点在事件文件同目录（随 STUDIO_EVENTS_FILE 测试隔离自动跟随）', () => {
    expect(ledgerFile).toBe(path.join(dir, 'token-ledger.json'));
  });

  it('单事件 → per-WU 行全口径字段照抄累计', async () => {
    appendEvent(tokenEvent('wu-1', {
      injectedTokens: 200,
      executionTokens: 12_345,
      totalTokens: 12_545,
      billedTokens: 20_000,
      inputTokens: 5_000,
      outputTokens: 7_345,
      cacheReadTokens: 6_000,
      cacheCreationTokens: 1_655,
      triggerId: 'trg-1',
      provider: 'claude',
    }));

    const ledger = await syncTokenLedger(eventsFile);
    const row = ledger.byWorkUnit['wu-1'];
    expect(row).toMatchObject({
      workUnitId: 'wu-1',
      events: 1,
      executionCount: 1,
      injectedTokens: 200,
      executionTokens: 12_345,
      totalTokens: 12_545,
      billedTokens: 20_000,
      inputTokens: 5_000,
      outputTokens: 7_345,
      cacheReadTokens: 6_000,
      cacheCreationTokens: 1_655,
      triggerId: 'trg-1',
      provider: 'claude',
    });
    // watermark 推进到文件尾部
    expect(ledger.watermark.lines).toBe(1);
    expect(ledger.watermark.bytes).toBe(fs.statSync(eventsFile).size);
  });

  it('同 WU 多事件累计；多 WU 分行；executionTokens=null 不计入但 events 照计', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 100, executionTokens: 1_000 }));
    appendEvent(tokenEvent('wu-1', { injectedTokens: 100, executionTokens: null, totalTokens: 100 }));
    appendEvent(tokenEvent('wu-2', { injectedTokens: 50, executionTokens: 500 }));

    const ledger = await syncTokenLedger(eventsFile);
    expect(Object.keys(ledger.byWorkUnit).sort()).toEqual(['wu-1', 'wu-2']);
    expect(ledger.byWorkUnit['wu-1']).toMatchObject({
      events: 2,
      executionCount: 1,
      injectedTokens: 200,
      executionTokens: 1_000, // null 不编造为 0（诚实口径）
    });
    expect(ledger.byWorkUnit['wu-2']).toMatchObject({ events: 1, executionTokens: 500 });
  });

  it('malformed payload / 非 token 事件 / 缺 workUnitId 的行跳过，不阻断其余入账', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    appendEvent({ type: 'workunit:tokens', source: 'test', payload: '{broken', createdAt: new Date().toISOString() });
    appendEvent({ type: 'knowledge:extraction', source: 'test', payload: JSON.stringify({ tokens: 999 }), createdAt: new Date().toISOString() });
    appendEvent({ type: 'workunit:tokens', source: 'test', payload: JSON.stringify({ executionTokens: 777 }), createdAt: new Date().toISOString() });

    const ledger = await syncTokenLedger(eventsFile);
    expect(Object.keys(ledger.byWorkUnit)).toEqual(['wu-1']);
    expect(ledger.byWorkUnit['wu-1'].executionTokens).toBe(100);
    // 4 行全部计入 watermark（跳过 ≠ 未入账，下次同步不重扫）
    expect(ledger.watermark.lines).toBe(4);
  });

  it('增量补扫：追加事件后再同步不重复累计', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    const first = await syncTokenLedger(eventsFile);
    expect(first.byWorkUnit['wu-1'].executionTokens).toBe(100);

    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 50 }));
    appendEvent(tokenEvent('wu-3', { injectedTokens: 5, executionTokens: 25 }));
    const second = await syncTokenLedger(eventsFile);
    expect(second.byWorkUnit['wu-1'].executionTokens).toBe(150); // 100 + 50，非 250
    expect(second.byWorkUnit['wu-1'].events).toBe(2);
    expect(second.byWorkUnit['wu-3'].executionTokens).toBe(25);
    expect(second.watermark.lines).toBe(3);
  });

  it('新鲜（size 未变）→ O(1) 直接返回，不重写账本文件', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    await syncTokenLedger(eventsFile);
    const mtimeAfterFirst = fs.statSync(ledgerFile).mtimeMs;

    const again = await syncTokenLedger(eventsFile);
    expect(again.byWorkUnit['wu-1'].executionTokens).toBe(100);
    expect(fs.statSync(ledgerFile).mtimeMs).toBe(mtimeAfterFirst);
  });

  it('轮转（事件文件变小、行数倒退）→ 清空重建，结果与当前事件流一致', async () => {
    appendEvent(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 1_000 }));
    appendEvent(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 1_000 }));
    await syncTokenLedger(eventsFile);

    // 模拟轮转：热信号被归档，新文件从头开始
    fs.writeFileSync(eventsFile, JSON.stringify(tokenEvent('wu-new', { injectedTokens: 1, executionTokens: 7 })) + '\n');
    const ledger = await syncTokenLedger(eventsFile);
    expect(ledger.byWorkUnit['wu-old']).toBeUndefined();
    expect(ledger.byWorkUnit['wu-new'].executionTokens).toBe(7);
    expect(ledger.watermark.lines).toBe(1);
  });

  it('事件文件消失（轮转窗口/清理）→ 空账本，不被陈旧账本文件骗', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    await syncTokenLedger(eventsFile);
    expect(fs.existsSync(ledgerFile)).toBe(true);

    fs.rmSync(eventsFile);
    const ledger = await syncTokenLedger(eventsFile);
    expect(ledger).toEqual(emptyTokenLedger());
  });

  it('noteTokenLedgerWritten 永不抛出：同步失败仅告警（写侧失败隔离，不阻断主流程）', async () => {
    // 构造 stat 必失败的路径（ENOTDIR：父路径是文件不是目录）
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const badEventsFile = path.join(blocker, 'studio-events.jsonl');
    await expect(noteTokenLedgerWritten(badEventsFile)).resolves.toBeUndefined();
  });

  it('noteTokenLedgerWritten 正常路径：事件落盘后账本同步更新', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    await noteTokenLedgerWritten(eventsFile);
    expect(readLedgerFile().byWorkUnit['wu-1'].executionTokens).toBe(100);
  });
});
