/**
 * FileStoreBase — FileStore 的底层原语层（从 file-store.ts 抽出）
 *
 * baseDir 解析、目录创建、JSON/JSONL 原子读写（tmp+rename）、mkdir 文件锁 withLock。
 * 上层域方法在 file-store-workunit.ts 与门面 file-store.ts 中经继承叠加。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { studioPath } from './config/studio-dir';
import { eventBus } from './event-bus';
import { logger } from './utils/logger';

/** 锁超时错误 */
export class LockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

// ─── 常量 ───

const LOCK_RETRY_INTERVAL_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** stale 兜底判据阈值（#64 决议 2）：acquiredAt / 锁目录 mtime 距今超此值即回收 */
const STALE_LOCK_AGE_MS = 30_000;

/** 锁内属主文件 owner.json（#64 决议 1：mkdir 获锁后写入锁目录） */
interface LockOwner {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

/** stale 命中判据：pid_dead = 主判据（同机 pid 已死）；age = 兜底判据（超龄） */
type StaleCriterion = 'pid_dead' | 'age';

// ─── 进程内 per-lockDir async mutex（#64 决议 5）───
// 同进程并发在 mutex 层排队，不打到 mkdir；跨进程互斥仍由 mkdir 保证。
const inProcessLocks = new Map<string, Promise<void>>();

async function acquireInProcessLock(lockDir: string): Promise<() => void> {
  const prev = inProcessLocks.get(lockDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = prev.then(() => current);
  inProcessLocks.set(lockDir, tail);
  await prev;
  // 尾结点 settle 后清理 map，避免无限增长；有新等待者接上时不动
  void tail.then(() => {
    if (inProcessLocks.get(lockDir) === tail) inProcessLocks.delete(lockDir);
  });
  return release;
}

/** pid 是否存活：kill(pid, 0) 报 ESRCH = 已死；EPERM = 存活但无权限（视为存活） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return isErrnoError(err) && err.code !== 'ESRCH';
  }
}

// ─── FileStoreBase 类 ───

export class FileStoreBase {
  protected baseDir: string;

  constructor(baseDir?: string) {
    // CWD 陷阱修复：baseDir 解耦 HOME。
    // buildSessionEnv 把 claude CLI 子进程 HOME 设成 agentHome（GAP-2 隔离），
    // 子进程里 new FileStore() 无参构造时 os.homedir() 返回 agentHome，baseDir 漂移到
    // ~/.studio/data/agents/<profile-id>/.studio/data 产生嵌套。STUDIO_DATA_DIR env
    // 由 API server bootstrap 显式设置并经 buildSessionEnv 透传，提供绝对路径锚点。
    this.baseDir = baseDir ?? process.env.STUDIO_DATA_DIR ?? studioPath('data');
  }

  // ─── 内部工具方法 ───

  /** 确保目录存在 */
  protected async ensureDir(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  /** 读取 JSON 文件，不存在或损坏返回 null */
  public async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      try {
        return JSON.parse(content) as T;
      } catch {
        return null; // corrupt JSON → treat as missing
      }
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * 写入 JSON 文件（原子写）。
   * 同目录 tmp 文件 + rename（同分区 rename 原子），进程崩溃或并发读不会看到撕裂内容；
   * tmp 名含 pid + 随机串防并发冲突；rename 前 fsync 落盘；失败时清理 tmp。
   */
  public async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const fh = await fs.promises.open(tmpPath, 'w');
      try {
        await fh.writeFile(JSON.stringify(data, null, 2), 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /** 追加一行 JSONL */
  public async appendJsonl(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.appendFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
  }

  /** 写入全部 JSONL 行（覆盖，原子写：同目录 tmp + rename，崩溃/并发读不见撕裂内容） */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const content = data.map(item => JSON.stringify(item)).join('\n') + (data.length > 0 ? '\n' : '');
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const fh = await fs.promises.open(tmpPath, 'w');
      try {
        await fh.writeFile(content, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /** 读取全部 JSONL 行（跳过解析失败的行） */
  public async readJsonl<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const results: T[] = [];
      for (const line of lines) {
        try {
          results.push(JSON.parse(line) as T);
        } catch {
          // skip corrupt lines
        }
      }
      return results;
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ─── 文件锁 ───

  /**
   * 基于 mkdir 原子性的跨进程文件锁。
   * 获取锁后执行 fn，释放锁后返回结果。
   * timeoutMs 为获取锁的超时时间。
   *
   * #64 决议 / #169：
   * - 获锁后写 owner.json（pid/hostname/acquiredAt），供 stale 判定；
   * - EEXIST 时先走 stale 双判据回收（pid_dead / age），回收发 lock.stale_reclaimed；
   * - 超时抛 LockTimeoutError 前发 lock.acquire_timeout；
   * - 同进程并发经进程内 per-lockDir mutex 排队，不打到 mkdir。
   */
  async withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
    const releaseMutex = await acquireInProcessLock(lockDir);
    try {
      // 确保父目录存在，防止 mkdir 因 ENOENT 失败
      await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
      const start = Date.now();
      // #210：owner 写入抛 ENOENT = 锁目录在获锁窗口内被并发回收方删除（从未真正持锁），
      // 跳回获取循环重试；受同一 timeoutMs 预算约束。labeled loop 见下。
      acquire: while (true) {
        while (true) {
          try {
            // 原子性创建锁目录（没有 recursive，存在即失败）
            await fs.promises.mkdir(lockDir);
            break;
          } catch (err: unknown) {
            // EEXIST 是预期中的锁冲突，其他错误直接抛
            if (!isErrnoError(err) || err.code !== 'EEXIST') throw err;
            // stale 双判据回收（#64 决议 2），回收成功立即回到 mkdir 竞争
            if (await this.tryReclaimStaleLock(lockDir)) continue;
            if (Date.now() - start > timeoutMs) {
              // #64 决议 3：首个 LockTimeoutError 即告警，不等回收
              this.emitLockEvent('lock.acquire_timeout', {
                lockDir,
                waitedMs: Date.now() - start,
                owner: await this.readLockOwner(lockDir),
              });
              throw new LockTimeoutError(timeoutMs);
            }
            await sleep(LOCK_RETRY_INTERVAL_MS);
          }
        }
        // 获锁后写属主文件；写失败必须放锁，避免留下无属主裸锁（只能靠超龄判据兜底）
        try {
          await this.writeJson(this.lockOwnerPath(lockDir), {
            pid: process.pid,
            hostname: os.hostname(),
            acquiredAt: Date.now(),
          });
          break acquire;
        } catch (err) {
          if (isErrnoError(err) && err.code === 'ENOENT') {
            // #210：锁目录已被回收，未持锁不算失败，回到 mkdir 竞争
            if (Date.now() - start > timeoutMs) throw new LockTimeoutError(timeoutMs);
            continue acquire;
          }
          await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      }
      try {
        return await fn();
      } finally {
        // 锁目录内含 owner.json，需 recursive 删除
        await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      releaseMutex();
    }
  }

  /** 锁内属主文件路径 */
  private lockOwnerPath(lockDir: string): string {
    return path.join(lockDir, 'owner.json');
  }

  /** 读取锁属主（不存在/损坏返回 null）。不走 this.readJson：FileStore 覆写了带读穿缓存的版本，锁属主判定要求跨进程实时性（同 readIndexFile 无缓存先例） */
  private async readLockOwner(lockDir: string): Promise<LockOwner | null> {
    try {
      const content = await fs.promises.readFile(this.lockOwnerPath(lockDir), 'utf-8');
      try {
        return JSON.parse(content) as LockOwner;
      } catch {
        return null; // corrupt JSON → treat as missing
      }
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * stale 双判据（#64 决议 2），满足其一即回收（删整个锁目录）并告警：
   * - pid_dead：owner.hostname 与本机相同且 pid 已死（ESRCH）；hostname 不同不走此判据；
   * - age：owner.acquiredAt 距今超 STALE_LOCK_AGE_MS；
   *   读不到 owner.json（窗口期 crash 残留/旧版裸锁）按锁目录 mtime 走同一超龄判据。
   * 返回是否发生了回收。
   */
  private async tryReclaimStaleLock(lockDir: string): Promise<boolean> {
    const owner = await this.readLockOwner(lockDir);
    let criterion: StaleCriterion | null = null;
    if (owner) {
      if (owner.hostname === os.hostname() && !isPidAlive(owner.pid)) {
        criterion = 'pid_dead';
      } else if (Date.now() - owner.acquiredAt > STALE_LOCK_AGE_MS) {
        criterion = 'age';
      }
    } else {
      try {
        const stat = await fs.promises.stat(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS) criterion = 'age';
      } catch {
        return false; // 锁目录已被对方释放，不算回收，回到正常 mkdir 竞争
      }
    }
    if (!criterion) return false;
    await fs.promises.rm(lockDir, { recursive: true, force: true });
    this.emitLockEvent('lock.stale_reclaimed', {
      lockDir,
      ownerPid: owner?.pid ?? null,
      ownerAcquiredAt: owner?.acquiredAt ?? null,
      criterion,
      reclaimerPid: process.pid,
    });
    return true;
  }

  /**
   * lock.* 结构化事件（均为 warning 级，不设 critical）：
   * 先落 logger，再发进程内 eventBus（订阅方 apps/api lock-events-bridge 走 dispatchMonitorAlerts 全管线）。
   * 发射失败不阻塞锁流程。
   */
  private emitLockEvent(type: 'lock.stale_reclaimed' | 'lock.acquire_timeout', payload: Record<string, unknown>): void {
    logger.warn(`[FileStore] ${type}`, payload);
    try {
      eventBus.publish(type, payload);
    } catch { /* non-blocking */ }
  }
}

export function isErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
