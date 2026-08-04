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

// ─── FileStoreBase 类 ───

export class FileStoreBase {
  protected baseDir: string;

  constructor(baseDir?: string) {
    // CWD 陷阱修复：baseDir 解耦 HOME。
    // buildSessionEnv 把 claude CLI 子进程 HOME 设成 agentHome（GAP-2 隔离），
    // 子进程里 new FileStore() 无参构造时 os.homedir() 返回 agentHome，baseDir 漂移到
    // ~/.studio/data/agents/<profile-id>/.studio/data 产生嵌套。STUDIO_DATA_DIR env
    // 由 API server bootstrap 显式设置并经 buildSessionEnv 透传，提供绝对路径锚点。
    this.baseDir = baseDir ?? process.env.STUDIO_DATA_DIR ?? path.join(os.homedir(), '.studio', 'data');
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

  /** 写入全部 JSONL 行（覆盖） */
  public async writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const content = data.map(item => JSON.stringify(item)).join('\n') + (data.length > 0 ? '\n' : '');
    await fs.promises.writeFile(filePath, content, 'utf-8');
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
   */
  async withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
    // 确保父目录存在，防止 mkdir 因 ENOENT 失败
    await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
    const start = Date.now();
    while (true) {
      try {
        // 原子性创建锁目录（没有 recursive，存在即失败）
        await fs.promises.mkdir(lockDir);
        break;
      } catch (err: unknown) {
        // EEXIST 是预期中的锁冲突，其他错误直接抛
        if (isErrnoError(err) && err.code !== 'EEXIST') throw err;
        if (Date.now() - start > timeoutMs) {
          throw new LockTimeoutError(timeoutMs);
        }
        await sleep(LOCK_RETRY_INTERVAL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.promises.rmdir(lockDir).catch(() => {});
    }
  }
}

export function isErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
