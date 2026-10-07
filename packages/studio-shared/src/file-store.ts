/**
 * FileStore — AN 运行时数据文件存储门面
 *
 * 运行时数据全部走文件存储（JSON/JSONL），flock（mkdir 原子操作）保障 claim 原子性。
 *
 * 数据区布局（data/ 子树与 ~/.studio 根级条目）唯一正本：
 * docs/architecture/data-directory-contract.md（#570）——布局变更须先修订契约。
 *
 * 本文件为纯门面（#670，PURE_MOVE）：数据类型在 file-store-types.ts，继承链逐层一个文件——
 *   file-store-base.ts             FileStoreBase               JSON/锁原语
 *   file-store-workunit.ts         FileStoreWorkUnitBase       WorkUnit 事件溯源
 *   file-store-cache.ts            （模块级件，无类）          读穿缓存共享件
 *   file-store-messages-core.ts    FileStoreMessagesCoreBase   消息写路径/压实（#319）/路径件
 *   file-store-messages-query.ts   FileStoreMessagesQueryBase  倒扫/分页（#524/B4）/水位线（B5）
 *   file-store-messages-archive.ts FileStoreMessagesArchiveBase 冷热归档/解冻（#327）
 *   file-store-messages.ts         FileStoreMessagesBase       消息子域组合壳（#655）
 *   file-store-cached.ts           FileStoreCachedBase         读穿缓存覆盖（A1，工单 26）
 *   file-store-entities.ts         FileStoreEntitiesBase       目录型实体 CRUD（#362）
 *   file-store-seq-entries.ts      FileStoreSeqEntriesBase     序号条目存储（工单 26 A2）
 *   file-store-docs.ts             FileStoreDocsBase           扁平目录清单/Markdown/索引
 * channels 编解码在 channels-codec.ts，frontmatter 在 frontmatter.ts；
 * 全部符号在此 re-export，导出面不变。
 */

import { FileStoreDocsBase } from './file-store-docs';

// ─── re-export（保持原有导出面 100% 不变）───

export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  MessageCompactionOptions,
  MessageArchiveOptions,
  WorkUnitEventType,
  WorkUnitEvent,
  WorkUnitSnapshot,
  WorkUnitFilter,
  RequirementStatus,
  RequirementData,
  RequirementFilter,
  EvolutionTargetType,
  EvolutionProposalStatus,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';
export { formatRequirementId, formatEvolutionId } from './file-store-types';
export { LockTimeoutError } from './file-store-base';
export type { WorkUnitReconcileResult } from './file-store-workunit';
export { parseWorkUnitIndexContent } from './file-store-workunit';
export { parseChannels, stringifyChannels } from './channels-codec';
export { parseFrontmatter, serializeFrontmatter } from './frontmatter';
export type { FileStoreOptions } from './file-store-messages';

// ─── FileStore 类（空门面，全部能力经继承链获得）───

export class FileStore extends FileStoreDocsBase {}
