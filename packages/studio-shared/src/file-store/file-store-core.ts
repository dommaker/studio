/**
 * FileStoreCore — FileStore 组合结构的共享设施上下文（#681 P1-1）
 *
 * 继承链时代各层经 `this` 虚分派共用基座原语；组合化后各域 store
 * （WorkUnitStore / MessagesStore / EntityStore / DocsStore）构造注入本上下文：
 * - base：FileStoreBase 裸读写原语 + withLock——锁内路径 / 跨进程实时性路径专用
 *   （ADR 2026-08-24-cache-seam-decision-rules 例外条款：锁内读必须裸读磁盘真值）；
 * - io：CachedFileIo 读穿缓存读写原语——默认读写路径（缓存的唯一实现，
 *   不再有「基类裸读缺省 + 子类覆盖」双形态）；
 * - baseDir：数据根（与 base 同源，FileStoreBase 构造时完成 env 解析）。
 */

import { FileStoreBase } from './file-store-base';
import { CachedFileIo } from './file-store-cached';

export interface FileStoreCore {
  readonly baseDir: string;
  readonly base: FileStoreBase;
  readonly io: CachedFileIo;
}

/** 构造共享设施（baseDir 解析只发生一次，各域 store 共用同一 base/io） */
export function createFileStoreCore(baseDir?: string): FileStoreCore {
  const base = new FileStoreBase(baseDir);
  return { baseDir: base.getDataDir(), base, io: new CachedFileIo(base) };
}
