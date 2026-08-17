/**
 * FileStoreBase 直接单元测试（不经门面 file-store.ts）
 *
 * 覆盖：JSON/JSONL 原子读写（tmp+rename 无残留、并发不撕裂、失败清理 tmp）、
 * ensureDir 幂等、mkdir 文件锁 withLock（互斥/超时/LockTimeoutError/释放语义）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { FileStoreBase, LockTimeoutError } from '../file-store-base';
import { eventBus } from '../event-bus';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-base-test-'));
}

/** 订阅 lock.* 事件并收集 payload，返回收集数组与退订函数 */
function collectLockEvents(type: 'lock.stale_reclaimed' | 'lock.acquire_timeout') {
  const events: Array<Record<string, unknown>> = [];
  const handler = (p: unknown) => events.push(p as Record<string, unknown>);
  eventBus.subscribe(type, handler);
  return { events, off: () => eventBus.unsubscribe(type, handler) };
}

/** 拿一个确定已退出的 pid（spawn 子进程并等其退出） */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  return child.pid!;
}

describe('FileStoreBase（直接单元测试）', () => {
  let tmpDir: string;
  let store: FileStoreBase;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStoreBase(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══ writeJson 原子写 ═══

  describe('writeJson 原子写', () => {
    it('写入后 readJson 可读回相同内容（嵌套结构保真）', async () => {
      const fp = path.join(tmpDir, 'roundtrip.json');
      const data = { id: 'a1', nested: { list: [1, 2, 3], flag: true }, note: null };
      await store.writeJson(fp, data);
      expect(await store.readJson(fp)).toEqual(data);
    });

    it('写入后不残留 tmp 文件', async () => {
      await store.writeJson(path.join(tmpDir, 'a.json'), { v: 1 });
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });

    it('自动创建不存在的父目录', async () => {
      const fp = path.join(tmpDir, 'nested', 'deep', 'b.json');
      await store.writeJson(fp, { created: true });
      expect(JSON.parse(fs.readFileSync(fp, 'utf-8'))).toEqual({ created: true });
    });

    it('覆盖已有文件内容', async () => {
      const fp = path.join(tmpDir, 'overwrite.json');
      await store.writeJson(fp, { v: 1 });
      await store.writeJson(fp, { v: 2 });
      expect(await store.readJson<{ v: number }>(fp)).toEqual({ v: 2 });
    });

    it('并发写不同文件互不干扰且无 tmp 残留', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) =>
        store.writeJson(path.join(tmpDir, `f-${i}.json`), { v: i })));
      for (let i = 0; i < 20; i++) {
        expect(JSON.parse(fs.readFileSync(path.join(tmpDir, `f-${i}.json`), 'utf-8'))).toEqual({ v: i });
      }
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });

    it('并发写同一文件不产生撕裂 JSON（结果必是某个完整 payload）', async () => {
      const fp = path.join(tmpDir, 'race.json');
      const payloads = Array.from({ length: 20 }, (_, i) => ({ v: i, pad: 'x'.repeat(4096) }));
      await Promise.all(payloads.map(p => store.writeJson(fp, p)));
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      expect(payloads).toContainEqual(parsed);
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });

    it('rename 失败时清理 tmp 文件并透传错误', async () => {
      // 目标是已存在目录 → rename(tmp 文件, 目录) 必失败，走 catch 清理分支
      const fp = path.join(tmpDir, 'is-a-dir');
      fs.mkdirSync(fp);
      await expect(store.writeJson(fp, { v: 1 })).rejects.toThrow();
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });
  });

  // ═══ readJson ═══

  describe('readJson', () => {
    it('文件不存在返回 null', async () => {
      expect(await store.readJson(path.join(tmpDir, 'nope.json'))).toBeNull();
    });

    it('损坏 JSON 返回 null（不抛错）', async () => {
      const fp = path.join(tmpDir, 'corrupt.json');
      fs.writeFileSync(fp, '{bad json');
      expect(await store.readJson(fp)).toBeNull();
    });
  });

  // ═══ JSONL 读写 ═══

  describe('JSONL 读写', () => {
    it('appendJsonl 追加多行并自动创建父目录', async () => {
      const fp = path.join(tmpDir, 'sub', 'deep', 'a.jsonl');
      await store.appendJsonl(fp, { n: 1 });
      await store.appendJsonl(fp, { n: 2 });
      const lines = fs.readFileSync(fp, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ n: 1 });
      expect(JSON.parse(lines[1])).toEqual({ n: 2 });
    });

    it('writeJsonl 覆盖写全部行', async () => {
      const fp = path.join(tmpDir, 'b.jsonl');
      await store.writeJsonl(fp, [{ n: 1 }, { n: 2 }]);
      await store.writeJsonl(fp, [{ n: 3 }]);
      expect(await store.readJsonl<{ n: number }>(fp)).toEqual([{ n: 3 }]);
    });

    it('writeJsonl 空数组写空文件', async () => {
      const fp = path.join(tmpDir, 'empty.jsonl');
      await store.writeJsonl(fp, []);
      expect(fs.readFileSync(fp, 'utf-8')).toBe('');
    });

    it('readJsonl 跳过损坏行保留合法行', async () => {
      const fp = path.join(tmpDir, 'corrupt.jsonl');
      fs.writeFileSync(fp, JSON.stringify({ n: 1 }) + '\nNOT-JSON\n' + JSON.stringify({ n: 2 }) + '\n');
      const rows = await store.readJsonl<{ n: number }>(fp);
      expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('readJsonl 文件不存在返回空数组', async () => {
      expect(await store.readJsonl(path.join(tmpDir, 'nope.jsonl'))).toEqual([]);
    });
  });

  // ═══ ensureDir ═══

  describe('ensureDir', () => {
    it('幂等：重复创建同一嵌套目录不抛错', async () => {
      // ensureDir 为 protected，经最小子类暴露以直接断言
      class Exposed extends FileStoreBase {
        async ensureDirTwice(dir: string): Promise<void> {
          await this.ensureDir(dir);
          await this.ensureDir(dir);
        }
      }
      const exposed = new Exposed(tmpDir);
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      await exposed.ensureDirTwice(nested);
      expect(fs.statSync(nested).isDirectory()).toBe(true);
    });
  });

  // ═══ withLock 文件锁 ═══

  describe('withLock', () => {
    const lockDir = () => path.join(tmpDir, 'locks', 'test.lock');

    it('返回 fn 的返回值', async () => {
      const r = await store.withLock(lockDir(), async () => 42);
      expect(r).toBe(42);
    });

    it('自动创建锁的父目录', async () => {
      const deep = path.join(tmpDir, 'x', 'y', 'lock');
      await store.withLock(deep, async () => 'ok');
      expect(fs.statSync(path.dirname(deep)).isDirectory()).toBe(true);
    });

    it('fn 返回后释放锁目录', async () => {
      await store.withLock(lockDir(), async () => 'ok');
      expect(fs.existsSync(lockDir())).toBe(false);
    });

    it('fn 抛错时透传错误并释放锁', async () => {
      await expect(store.withLock(lockDir(), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(fs.existsSync(lockDir())).toBe(false);
    });

    it('互斥：并发临界区不重叠', async () => {
      let inCritical = false;
      let overlap = false;
      await Promise.all(Array.from({ length: 5 }, () =>
        store.withLock(lockDir(), async () => {
          if (inCritical) overlap = true;
          inCritical = true;
          await new Promise(r => setTimeout(r, 20));
          inCritical = false;
        })));
      expect(overlap).toBe(false);
    });

    it('互斥：持锁 read-modify-write 不丢更新', async () => {
      let counter = 0;
      await Promise.all(Array.from({ length: 20 }, () =>
        store.withLock(lockDir(), async () => {
          const cur = counter;
          await new Promise(r => setTimeout(r, 1));
          counter = cur + 1;
        })));
      expect(counter).toBe(20);
    });

    it('锁被占用时阻塞等待，占用方释放后获取成功', async () => {
      fs.mkdirSync(lockDir(), { recursive: true }); // 模拟他方持锁
      let acquired = false;
      const p = store.withLock(lockDir(), async () => { acquired = true; return 'done'; }, 3000);
      await new Promise(r => setTimeout(r, 100));
      expect(acquired).toBe(false); // 占用期间抢不到
      fs.rmdirSync(lockDir()); // 模拟持锁方释放
      await expect(p).resolves.toBe('done');
      expect(acquired).toBe(true);
      expect(fs.existsSync(lockDir())).toBe(false); // 用完后自己释放
    });

    it('超时抛出 LockTimeoutError，且不误删他人锁', async () => {
      fs.mkdirSync(lockDir(), { recursive: true }); // 模拟他方持锁不放
      const err = await store.withLock(lockDir(), async () => 'never', 200).catch(e => e);
      expect(err).toBeInstanceOf(LockTimeoutError);
      expect(err.name).toBe('LockTimeoutError');
      expect(err.message).toContain('200');
      expect(fs.existsSync(lockDir())).toBe(true); // 未获取锁，不进入 finally 的 rmdir
    });
  });

  // ═══ withLock stale 回收 / owner.json / 进程内 mutex（#169 / #64）═══

  describe('withLock stale 回收与 owner.json（#169）', () => {
    const lockDir = () => path.join(tmpDir, 'locks', 'stale.lock');
    const ownerPath = () => path.join(lockDir(), 'owner.json');

    const writeOwner = (owner: { pid: number; hostname: string; acquiredAt: number }) => {
      fs.mkdirSync(lockDir(), { recursive: true });
      fs.writeFileSync(ownerPath(), JSON.stringify(owner));
    };

    it('持锁期间锁目录内有 owner.json（pid/hostname/acquiredAt），释放后整体删除', async () => {
      let seen: { pid: number; hostname: string; acquiredAt: number } | null = null;
      await store.withLock(lockDir(), async () => {
        seen = JSON.parse(fs.readFileSync(ownerPath(), 'utf-8'));
        return 'ok';
      });
      expect(seen).not.toBeNull();
      expect(seen!.pid).toBe(process.pid);
      expect(seen!.hostname).toBe(os.hostname());
      expect(typeof seen!.acquiredAt).toBe('number');
      expect(fs.existsSync(lockDir())).toBe(false); // 含 owner.json 也能整体释放
    });

    it('主判据：同机死 pid 的锁被回收，发 lock.stale_reclaimed（criterion=pid_dead）', async () => {
      const pid = await deadPid();
      writeOwner({ pid, hostname: os.hostname(), acquiredAt: Date.now() });
      const { events, off } = collectLockEvents('lock.stale_reclaimed');
      try {
        const r = await store.withLock(lockDir(), async () => 'acquired', 3000);
        expect(r).toBe('acquired');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          lockDir: lockDir(),
          ownerPid: pid,
          criterion: 'pid_dead',
          reclaimerPid: process.pid,
        });
        expect(typeof events[0].ownerAcquiredAt).toBe('number');
      } finally {
        off();
      }
    });

    it('兜底判据：活 pid 但 acquiredAt 超 30s 的锁被回收（criterion=age）', async () => {
      writeOwner({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() - 31_000 });
      const { events, off } = collectLockEvents('lock.stale_reclaimed');
      try {
        const r = await store.withLock(lockDir(), async () => 'acquired', 3000);
        expect(r).toBe('acquired');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ criterion: 'age', ownerPid: process.pid });
      } finally {
        off();
      }
    });

    it('无 owner.json 的裸锁按目录 mtime 走超龄判据：超龄回收，未超龄不回收', async () => {
      // 超龄裸锁 → 回收
      fs.mkdirSync(lockDir(), { recursive: true });
      const past = new Date(Date.now() - 31_000);
      fs.utimesSync(lockDir(), past, past);
      const { events, off } = collectLockEvents('lock.stale_reclaimed');
      try {
        await expect(store.withLock(lockDir(), async () => 'acquired', 3000)).resolves.toBe('acquired');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ criterion: 'age', ownerPid: null, ownerAcquiredAt: null });
      } finally {
        off();
      }
      // 未超龄裸锁 → 不回收，超时且锁目录保留
      fs.mkdirSync(lockDir(), { recursive: true });
      const err = await store.withLock(lockDir(), async () => 'never', 200).catch(e => e);
      expect(err).toBeInstanceOf(LockTimeoutError);
      expect(fs.existsSync(lockDir())).toBe(true);
      expect(events).toHaveLength(1); // 未新增回收事件
    });

    it('活 pid 且未超龄的锁不被误回收：超时抛 LockTimeoutError，发 lock.acquire_timeout 携带 owner', async () => {
      writeOwner({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() });
      const reclaimed = collectLockEvents('lock.stale_reclaimed');
      const timeouts = collectLockEvents('lock.acquire_timeout');
      try {
        const err = await store.withLock(lockDir(), async () => 'never', 200).catch(e => e);
        expect(err).toBeInstanceOf(LockTimeoutError);
        expect(fs.existsSync(ownerPath())).toBe(true); // 锁未被回收
        expect(reclaimed.events).toHaveLength(0);
        expect(timeouts.events).toHaveLength(1);
        expect(timeouts.events[0]).toMatchObject({ lockDir: lockDir() });
        expect(timeouts.events[0].waitedMs as number).toBeGreaterThanOrEqual(200);
        expect(timeouts.events[0].owner).toMatchObject({ pid: process.pid, hostname: os.hostname() });
      } finally {
        reclaimed.off();
        timeouts.off();
      }
    });

    it('hostname 不同不走 pid 判据：异机死 pid 且未超龄的锁不回收', async () => {
      const pid = await deadPid();
      writeOwner({ pid, hostname: 'other-host', acquiredAt: Date.now() });
      const { events, off } = collectLockEvents('lock.stale_reclaimed');
      try {
        const err = await store.withLock(lockDir(), async () => 'never', 200).catch(e => e);
        expect(err).toBeInstanceOf(LockTimeoutError);
        expect(fs.existsSync(ownerPath())).toBe(true);
        expect(events).toHaveLength(0);
      } finally {
        off();
      }
    });

    it('hostname 不同仍走超龄兜底：异机锁 acquiredAt 超 30s 被回收', async () => {
      const pid = await deadPid();
      writeOwner({ pid, hostname: 'other-host', acquiredAt: Date.now() - 31_000 });
      const { events, off } = collectLockEvents('lock.stale_reclaimed');
      try {
        await expect(store.withLock(lockDir(), async () => 'acquired', 3000)).resolves.toBe('acquired');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ criterion: 'age', ownerPid: pid });
      } finally {
        off();
      }
    });

    it('#210 owner 写入抛 ENOENT（锁目录被并发回收）：回到获取循环重试而非致命错', async () => {
      const pid = await deadPid();
      writeOwner({ pid, hostname: os.hostname(), acquiredAt: Date.now() });
      const orig = store.writeJson.bind(store);
      let injected = false;
      // 模拟：mkdir 获锁后、owner.json rename 前，并发回收方删掉锁目录 -> writeJson 抛 ENOENT
      store.writeJson = async (fp: string, data: unknown) => {
        if (!injected && fp.endsWith('owner.json')) {
          injected = true;
          fs.rmSync(lockDir(), { recursive: true, force: true });
          const err = new Error(`ENOENT: rename ${fp}.tmp`) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return orig(fp, data);
      };
      try {
        await expect(store.withLock(lockDir(), async () => 'acquired', 3000)).resolves.toBe('acquired');
        expect(injected).toBe(true);
        expect(fs.existsSync(lockDir())).toBe(false); // 重试获锁后正常释放
      } finally {
        store.writeJson = orig;
      }
    });

    it('进程内 mutex：同进程并发在 mutex 层排队，mkdir 竞争超时参数不误伤排队者', async () => {
      const timeouts = collectLockEvents('lock.acquire_timeout');
      try {
        let holderIn = false;
        // 持锁 150ms；第二个调用 timeoutMs=50 —— 若无 mutex 会在 mkdir 自旋中超时
        const first = store.withLock(lockDir(), async () => {
          holderIn = true;
          await new Promise(r => setTimeout(r, 150));
          holderIn = false;
          return 'first';
        });
        await new Promise(r => setTimeout(r, 30)); // 确保 first 已持锁
        expect(holderIn).toBe(true);
        const second = store.withLock(lockDir(), async () => {
          expect(holderIn).toBe(false); // 不重叠
          return 'second';
        }, 50);
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second'); // mutex 排队成功获取，不超时
        expect(timeouts.events).toHaveLength(0);
      } finally {
        timeouts.off();
      }
    });
  });

  // ═══ LockTimeoutError ═══

  describe('LockTimeoutError', () => {
    it('name 为 LockTimeoutError，message 携带超时毫秒数', () => {
      const err = new LockTimeoutError(1234);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('LockTimeoutError');
      expect(err.message).toContain('1234');
    });
  });
});
