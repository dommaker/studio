/**
 * #320 token 账本（token ledger）— workunit:tokens 事件流的写侧累计派生索引。
 *
 * 验证 grilling 定稿的核心契约：事件流仍是唯一真源；账本可重建；
 * watermark（lines+bytes+dev:ino generation+首/末完整行内容锚点）自愈——落后增量补扫，
 * 轮转/copytruncate/截断重建，不存在即懒回填；新鲜时只做 O(1) 锚点校验，不重写账本。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getStore } from '../../../core/store.js';

import {
  resolveTokenLedgerFile,
  syncTokenLedger,
  noteTokenLedgerWritten,
  emptyTokenLedger,
  type TokenLedger,
} from '../token-ledger.js';
import { writeWorkunitTokenEvent } from '../../agent-loop/agent-loop-events.js';

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

  it('崩溃半行不进入 checkpoint；补全后恰好入账一次', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 10, executionTokens: 100 }));
    await syncTokenLedger(eventsFile);
    const before = readLedgerFile();
    const serialized = JSON.stringify(tokenEvent('wu-2', { injectedTokens: 5, executionTokens: 50 })) + '\n';
    const splitAt = Math.floor(Buffer.byteLength(serialized) / 2);
    const bytes = Buffer.from(serialized);

    fs.appendFileSync(eventsFile, bytes.subarray(0, splitAt));
    const partial = await syncTokenLedger(eventsFile);
    expect(partial.watermark).toEqual(before.watermark);
    expect(partial.byWorkUnit['wu-2']).toBeUndefined();

    fs.appendFileSync(eventsFile, bytes.subarray(splitAt));
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-1'].executionTokens).toBe(100);
    expect(recovered.byWorkUnit['wu-2'].executionTokens).toBe(50);
    expect(recovered.watermark.lines).toBe(2);
    expect(recovered.watermark.bytes).toBe(fs.statSync(eventsFile).size);
  });

  it('同 inode 截断缩短 → 丢弃旧累计并从当前代际重建', async () => {
    const first = JSON.stringify(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 100 })) + '\n';
    fs.writeFileSync(eventsFile, first + JSON.stringify(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 200 })) + '\n');
    await syncTokenLedger(eventsFile);

    fs.writeFileSync(eventsFile, first);
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-old']).toMatchObject({ events: 1, executionTokens: 100 });
    expect(recovered.watermark.lines).toBe(1);
    expect(recovered.watermark.bytes).toBe(Buffer.byteLength(first));
  });

  it('copytruncate 同 inode 重写到同大小：内容锚点不符必须重建', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const oldLine = JSON.stringify(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 100 }, createdAt)) + '\n';
    const newLine = JSON.stringify(tokenEvent('wu-new', { injectedTokens: 20, executionTokens: 200 }, createdAt)) + '\n';
    expect(Buffer.byteLength(newLine)).toBe(Buffer.byteLength(oldLine));
    fs.writeFileSync(eventsFile, oldLine);
    await syncTokenLedger(eventsFile);
    const inode = fs.statSync(eventsFile).ino;

    fs.writeFileSync(eventsFile, newLine); // copytruncate：同 inode、同 size，历史内容已替换
    expect(fs.statSync(eventsFile).ino).toBe(inode);
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-old']).toBeUndefined();
    expect(recovered.byWorkUnit['wu-new']).toMatchObject({ events: 1, executionTokens: 200 });
    expect(recovered.watermark.lines).toBe(1);
  });

  it('copytruncate [A,B] → 同大小 [C,B]：末行锚不变时首行锚仍须识别重写', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const a = JSON.stringify(tokenEvent('wu-a', { injectedTokens: 10, executionTokens: 100 }, createdAt)) + '\n';
    const b = JSON.stringify(tokenEvent('wu-b', { injectedTokens: 20, executionTokens: 200 }, createdAt)) + '\n';
    const c = JSON.stringify(tokenEvent('wu-c', { injectedTokens: 30, executionTokens: 300 }, createdAt)) + '\n';
    expect(Buffer.byteLength(c)).toBe(Buffer.byteLength(a));
    fs.writeFileSync(eventsFile, a + b);
    await syncTokenLedger(eventsFile);
    const inode = fs.statSync(eventsFile).ino;

    fs.writeFileSync(eventsFile, c + b);
    expect(fs.statSync(eventsFile).ino).toBe(inode);
    expect(fs.statSync(eventsFile).size).toBe(Buffer.byteLength(a + b));
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-a']).toBeUndefined();
    expect(recovered.byWorkUnit['wu-c']).toMatchObject({ events: 1, executionTokens: 300 });
    expect(recovered.byWorkUnit['wu-b']).toMatchObject({ events: 1, executionTokens: 200 });
    expect(recovered.watermark.lines).toBe(2);
  });

  it('copytruncate 同 inode 重长到更大且旧 offset 边界合法：仍须全量重建', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const oldLine = JSON.stringify(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 100 }, createdAt)) + '\n';
    const newFirst = JSON.stringify(tokenEvent('wu-new', { injectedTokens: 20, executionTokens: 200 }, createdAt)) + '\n';
    const newSecond = JSON.stringify(tokenEvent('wu-new', { injectedTokens: 1, executionTokens: 7 }, createdAt)) + '\n';
    expect(Buffer.byteLength(newFirst)).toBe(Buffer.byteLength(oldLine));
    fs.writeFileSync(eventsFile, oldLine);
    await syncTokenLedger(eventsFile);
    const inode = fs.statSync(eventsFile).ino;

    fs.writeFileSync(eventsFile, newFirst + newSecond);
    expect(fs.statSync(eventsFile).ino).toBe(inode);
    expect(fs.statSync(eventsFile).size).toBeGreaterThan(Buffer.byteLength(oldLine));
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-old']).toBeUndefined();
    expect(recovered.byWorkUnit['wu-new']).toMatchObject({ events: 2, executionTokens: 207 });
    expect(recovered.watermark.lines).toBe(2);
  });

  it('copytruncate 后经公共 writer 追加：direct-apply 不洗掉内容锚点，下一次同步仍重建', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const oldLine = JSON.stringify(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 100 }, createdAt)) + '\n';
    const newLine = JSON.stringify(tokenEvent('wu-new', { injectedTokens: 20, executionTokens: 200 }, createdAt)) + '\n';
    fs.writeFileSync(eventsFile, oldLine);
    await syncTokenLedger(eventsFile);
    fs.writeFileSync(eventsFile, newLine);

    await writeWorkunitTokenEvent(eventsFile, {
      workUnitId: 'wu-latest', executionId: 'latest-1', injectedTokens: 1, executionTokens: 7,
    });
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-old']).toBeUndefined();
    expect(recovered.byWorkUnit['wu-new'].executionTokens).toBe(200);
    expect(recovered.byWorkUnit['wu-latest'].executionTokens).toBe(7);
    expect(recovered.watermark.lines).toBe(2);
    expect(recovered.watermark.bytes).toBe(fs.statSync(eventsFile).size);
  });

  it('轮换成更大文件也必须按代际重建，不能沿用旧账本', async () => {
    appendEvent(tokenEvent('wu-old', { injectedTokens: 10, executionTokens: 100 }));
    await syncTokenLedger(eventsFile);
    fs.renameSync(eventsFile, `${eventsFile}.1`);
    appendEvent(tokenEvent('wu-new', { injectedTokens: 1, executionTokens: 7 }));
    appendEvent(tokenEvent('wu-new', { injectedTokens: 1, executionTokens: 8 }));

    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-old']).toBeUndefined();
    expect(recovered.byWorkUnit['wu-new']).toMatchObject({ events: 2, executionTokens: 15 });
    expect(recovered.watermark.lines).toBe(2);
  });

  it('direct-apply 提交前其他进程追加事件：watermark 不越过未处理行，补扫不丢不重', async () => {
    appendEvent(tokenEvent('wu-base', { injectedTokens: 1, executionTokens: 1 }));
    await syncTokenLedger(eventsFile);

    const store = getStore();
    const originalWriteJson = store.writeJson.bind(store);
    let appendedByOtherWriter = false;
    let ownEnd = 0;
    const writeSpy = vi.spyOn(store, 'writeJson').mockImplementation(async (file, data) => {
      if (file === ledgerFile && !appendedByOtherWriter) {
        appendedByOtherWriter = true;
        ownEnd = fs.statSync(eventsFile).size;
        // 模拟另一进程在 direct-apply 已验证自身行后、账本提交前追加。
        appendEvent(tokenEvent('wu-other', { injectedTokens: 3, executionTokens: 30 }));
      }
      return originalWriteJson(file, data);
    });
    try {
      await writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-own', executionId: 'own-1', injectedTokens: 2, executionTokens: 20,
      });
      const direct = readLedgerFile();
      expect(direct.byWorkUnit['wu-own'].executionTokens).toBe(20);
      expect(direct.byWorkUnit['wu-other']).toBeUndefined();
      expect(direct.watermark.bytes).toBe(ownEnd);

      const recovered = await syncTokenLedger(eventsFile);
      expect(recovered.byWorkUnit['wu-own'].executionTokens).toBe(20);
      expect(recovered.byWorkUnit['wu-other'].executionTokens).toBe(30);
      expect(recovered.watermark.bytes).toBe(fs.statSync(eventsFile).size);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('四个真实进程并发追加 100 条：跨进程锁下全部事件恰好入账一次', { timeout: 30_000 }, async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
    const writerModule = path.join(repoRoot, 'apps/api/src/modules/agent-loop/agent-loop-events.ts');
    const workers = Array.from({ length: 4 }, (_, worker) => {
      const script = `
        void (async () => {
          const imported = await import(${JSON.stringify(writerModule)});
          const { writeWorkunitTokenEvent } = imported.default ?? imported;
          for (let i = 0; i < 25; i += 1) {
            await writeWorkunitTokenEvent(${JSON.stringify(eventsFile)}, {
              workUnitId: 'wu-concurrent', executionId: '${worker}-' + i,
              injectedTokens: 1, executionTokens: i + 1,
            });
          }
        })();
      `;
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, '-e', script], {
          env: { ...process.env, NODE_ENV: 'test', STUDIO_AUTH: 'none' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', code => code === 0
          ? resolve()
          : reject(new Error(`token writer ${worker} exited ${code}: ${stderr}`)));
      });
    });
    await Promise.all(workers);

    const ledger = await syncTokenLedger(eventsFile);
    expect(ledger.byWorkUnit['wu-concurrent']).toMatchObject({
      events: 100,
      executionCount: 100,
      executionTokens: 4 * (25 * 26 / 2),
    });
    expect(ledger.watermark.lines).toBe(100);
    expect(ledger.watermark.bytes).toBe(fs.statSync(eventsFile).size);
  });

  it('账本/checkpoint 原子提交后调用方收到失败：公共 writer 重试恢复不重复累计', async () => {
    appendEvent(tokenEvent('wu-1', { injectedTokens: 1, executionTokens: 10 }));
    await syncTokenLedger(eventsFile);

    const store = getStore();
    const originalWriteJson = store.writeJson.bind(store);
    let injected = false;
    const writeSpy = vi.spyOn(store, 'writeJson').mockImplementation(async (file, data) => {
      if (file === ledgerFile && !injected) {
        injected = true;
        await originalWriteJson(file, data);
        throw new Error('simulated crash after durable ledger commit');
      }
      return originalWriteJson(file, data);
    });
    try {
      await expect(writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-1', executionId: 'wu-1-2', injectedTokens: 2, executionTokens: 20,
      })).resolves.toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
    const recovered = await syncTokenLedger(eventsFile);
    expect(recovered.byWorkUnit['wu-1']).toMatchObject({ events: 2, executionTokens: 30 });
    expect(recovered.watermark.bytes).toBe(fs.statSync(eventsFile).size);
  });
});
