/**
 * FileStoreMessagesBase — 频道消息子域组合壳（#670 三层拆分后收编为壳，PURE_MOVE）
 *
 * 子域三层链（每层一个文件）：
 *   file-store-messages-core.ts    FileStoreMessagesCoreBase    写路径/压实（#319）/路径件/readdir 缓存
 *   file-store-messages-query.ts   FileStoreMessagesQueryBase   尾部倒扫/分页（#524/B4）/增量水位线（B5）/跨频道查询
 *   file-store-messages-archive.ts FileStoreMessagesArchiveBase 冷热归档与解冻（#327）
 * 本类为空类继承链顶，对外类名与行为不变（#655 起门面 FileStore 再继承本类）。
 * 读穿缓存模块级共享件（dirCache/cacheSet/statMtimeMs/CacheEntry 等）已随 #670
 * 移至 file-store-cache.ts。
 */

import { FileStoreMessagesArchiveBase } from './file-store-messages-archive';

export class FileStoreMessagesBase extends FileStoreMessagesArchiveBase {}

export type { FileStoreOptions } from './file-store-messages-core';
