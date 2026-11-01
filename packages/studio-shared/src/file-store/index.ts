/**
 * FileStore — AN 运行时数据文件存储门面（#681 P1-1：继承链改组合）
 *
 * 运行时数据全部走文件存储（JSON/JSONL），flock（mkdir 原子操作）保障 claim 原子性。
 *
 * 数据区布局（data/ 子树与 ~/.studio 根级条目）唯一正本：
 * docs/architecture/data-directory-contract.md（#570）——布局变更须先修订契约。
 *
 * 本文件为组合门面（原 file-store.ts，现为本目录 index）：持有四个域 store 实例并逐方法委托，
 * 对外类名/构造签名/方法签名/导出面 100% 不变（消费方零改动）。内部结构（均在本目录）：
 *   file-store-core.ts             FileStoreCore/createFileStoreCore  共享设施上下文（baseDir/base/io）
 *   file-store-base.ts             FileStoreBase                      JSON/锁裸原语（锁内/实时路径专用）
 *   file-store-cached.ts           CachedFileIo                       读穿缓存读写原语（唯一实现）
 *   cache-primitives.ts            （模块级件，无类）                  缓存共享件
 *   file-store-workunit.ts         WorkUnitStore                      WorkUnit 事件溯源
 *   file-store-messages-core.ts    MessagesCoreStore                  消息写路径/压实（#319）/路径件
 *   file-store-messages-query.ts   MessagesQueryStore                 倒扫/分页（#524/B4）/水位线（B5）
 *   file-store-messages-archive.ts MessagesArchiveStore               冷热归档/解冻（#327）
 *   file-store-messages.ts         MessagesStore                      消息子域组合壳（core/query/archive）
 *   file-store-entities.ts         EntityStore                        目录型实体 CRUD（#362）+ 序号条目（A2）
 *   file-store-docs.ts             DocsStore                          扁平目录清单/Markdown/索引
 * channels 编解码在 channels-codec.ts，frontmatter 在 frontmatter.ts；
 * 全部符号在此 re-export，导出面不变。
 */

import type fs from 'node:fs';
import { createFileStoreCore, type FileStoreCore } from './file-store-core';
import { WorkUnitStore, type WorkUnitReconcileResult } from './file-store-workunit';
import { MessagesStore, type FileStoreOptions } from './file-store-messages';
import { EntityStore } from './file-store-entities';
import { DocsStore } from './file-store-docs';
import type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  WorkUnitEvent,
  WorkUnitSnapshot,
  WorkUnitFilter,
  RequirementData,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalFilter,
} from './file-store-types';

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
export { WorkUnitMetadataRepository } from './workunit-metadata-repository';
export type { WorkUnitMetadataWritePort } from './workunit-metadata-repository';
export { parseChannels, stringifyChannels } from '../channels-codec';
export { parseFrontmatter, serializeFrontmatter } from '../frontmatter';
export type { FileStoreOptions } from './file-store-messages';

// ─── FileStore 类（组合门面：持有域 store 实例，逐方法委托）───

export class FileStore {
  private readonly ctx: FileStoreCore;
  private readonly workunitStore: WorkUnitStore;
  private readonly messagesStore: MessagesStore;
  private readonly entityStore: EntityStore;
  private readonly docsStore: DocsStore;

  constructor(baseDir?: string, opts?: FileStoreOptions) {
    this.ctx = createFileStoreCore(baseDir);
    this.workunitStore = new WorkUnitStore(this.ctx, opts);
    this.messagesStore = new MessagesStore(this.ctx, this.workunitStore, opts);
    this.entityStore = new EntityStore(this.ctx);
    this.docsStore = new DocsStore(this.ctx);
  }

  // ─── 共享设施（base 裸原语 + CachedFileIo 读穿缓存）───

  /** 数据根目录只读访问（台账类模块拼子路径用，#602 D5 incident-ledger 起） */
  getDataDir(): string {
    return this.ctx.baseDir;
  }

  /** 跨进程 mkdir 文件锁（语义见 file-store-base.ts） */
  withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return this.ctx.base.withLock(lockDir, fn, timeoutMs);
  }

  /** 读取 JSON 文件（读穿缓存），不存在或损坏返回 null */
  readJson<T>(filePath: string): Promise<T | null> {
    return this.ctx.io.readJson<T>(filePath);
  }

  /** 锁内/跨进程实时路径专用：绕过读穿缓存，直接读取磁盘真值 */
  readJsonUncached<T>(filePath: string): Promise<T | null> {
    return this.ctx.base.readJson<T>(filePath);
  }

  /** 写入 JSON 文件（原子写），写后失效缓存 */
  writeJson(filePath: string, data: unknown): Promise<void> {
    return this.ctx.io.writeJson(filePath, data);
  }

  /** 追加一行 JSONL，写后失效缓存 */
  appendJsonl(filePath: string, data: unknown): Promise<void> {
    return this.ctx.io.appendJsonl(filePath, data);
  }

  /** 写入全部 JSONL 行（覆盖，原子写），写后失效缓存 */
  writeJsonl(filePath: string, data: unknown[]): Promise<void> {
    return this.ctx.io.writeJsonl(filePath, data);
  }

  /** 读取全部 JSONL 行（读穿缓存；跳过解析失败的行） */
  readJsonl<T>(filePath: string): Promise<T[]> {
    return this.ctx.io.readJsonl<T>(filePath);
  }

  /** readdir 读穿缓存公开入口（#321）：聚合读层扫外部仓目录用；目录不存在抛 ENOENT */
  readdir(dir: string): Promise<fs.Dirent[]> {
    return this.ctx.io.readdir(dir);
  }

  // ─── WorkUnit 事件溯源（WorkUnitStore）───

  appendEvent(event: WorkUnitEvent): Promise<void> {
    return this.workunitStore.appendEvent(event);
  }

  getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    return this.workunitStore.getIndex(filter);
  }

  /** PERF-03 调度观察用 O(1) 本进程 index 写版本；跨进程 freshness 仍靠 mtime/兜底刷新。 */
  getIndexVersion(): number {
    return this.workunitStore.getIndexVersion();
  }

  rebuildIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]> {
    return this.workunitStore.rebuildIndex(filter);
  }

  claimWorkUnit(wuId: string, assigneeId: string, opts?: { assigneeRoleId?: string | null; timeoutAt?: string | null }): Promise<boolean> {
    return this.workunitStore.claimWorkUnit(wuId, assigneeId, opts);
  }

  upsertSnapshot(snapshot: WorkUnitSnapshot): Promise<void> {
    return this.workunitStore.upsertSnapshot(snapshot);
  }

  removeSnapshot(id: string): Promise<void> {
    return this.workunitStore.removeSnapshot(id);
  }

  commitSnapshot(event: WorkUnitEvent, snapshot: WorkUnitSnapshot): Promise<void> {
    return this.workunitStore.commitSnapshot(event, snapshot);
  }

  commitRemoval(event: WorkUnitEvent, id: string): Promise<void> {
    return this.workunitStore.commitRemoval(event, id);
  }

  refreshWorkUnitLease(
    wuId: string,
    expectedAssigneeId: string,
    expectedClaimedAt: string,
    timeoutAt: Date,
  ): Promise<'ok' | 'lost' | 'missing'> {
    return this.workunitStore.refreshWorkUnitLease(wuId, expectedAssigneeId, expectedClaimedAt, timeoutAt);
  }

  flushWorkUnitLeases(): Promise<{ flushed: number; dropped: number }> {
    return this.workunitStore.flushWorkUnitLeases();
  }

  updateMetadata(
    wuId: string,
    mutator: (current: Record<string, unknown>) => Record<string, unknown>,
    opts?: { touchUpdatedAt?: boolean },
  ): Promise<WorkUnitSnapshot | null> {
    return this.workunitStore.updateMetadata(wuId, mutator, opts);
  }

  createSnapshotGuarded(
    snapshot: WorkUnitSnapshot,
    guard: (snapshots: WorkUnitSnapshot[]) => boolean,
  ): Promise<boolean> {
    return this.workunitStore.createSnapshotGuarded(snapshot, guard);
  }

  reconcileIndex(): Promise<WorkUnitReconcileResult> {
    return this.workunitStore.reconcileIndex();
  }

  // ─── 频道消息（MessagesStore）───

  appendMessage(channelId: string, msg: ChannelMessageData): Promise<void> {
    return this.messagesStore.appendMessage(channelId, msg);
  }

  softDeleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.messagesStore.softDeleteMessage(channelId, messageId);
  }

  getChannelVersion(channelId: string): Promise<{ lastMessageId: string | null }> {
    return this.messagesStore.getChannelVersion(channelId);
  }

  getMessagesSince(channelId: string, messageId: string | null): Promise<ChannelMessageData[]> {
    return this.messagesStore.getMessagesSince(channelId, messageId);
  }

  readMessagesTail(
    channelId: string,
    opts: { limit: number; match?: (m: ChannelMessageData) => boolean },
  ): Promise<{ messages: ChannelMessageData[]; exhausted: boolean }> {
    return this.messagesStore.readMessagesTail(channelId, opts);
  }

  readChannelMessagesDelta(
    channelId: string,
    fromOffset: number,
    opts: { boundarySinceMs: number },
  ): Promise<{ messages: ChannelMessageData[]; newOffset: number; endOffset: number; valid: boolean }> {
    return this.messagesStore.readChannelMessagesDelta(channelId, fromOffset, opts);
  }

  listMessageChannelIds(): Promise<string[]> {
    return this.messagesStore.listMessageChannelIds();
  }

  queryMessages(channelId: string, opts?: QueryOpts): Promise<ChannelMessageData[]> {
    return this.messagesStore.queryMessages(channelId, opts);
  }

  queryMessagesPage(channelId: string, opts?: MessagePageOpts): Promise<MessagePage> {
    return this.messagesStore.queryMessagesPage(channelId, opts);
  }

  queryAllMessages(filter?: { workUnitIds?: string[]; workUnitId?: string; authorType?: string; agentName?: string; agentNames?: string[]; channelIds?: string[] }): Promise<ChannelMessageData[]> {
    return this.messagesStore.queryAllMessages(filter);
  }

  getMessageById(messageId: string, channelId?: string): Promise<{ channelId: string; message: ChannelMessageData } | null> {
    return this.messagesStore.getMessageById(messageId, channelId);
  }

  archiveChannelMessages(): Promise<{ archivedMessages: number }> {
    return this.messagesStore.archiveChannelMessages();
  }

  thawWorkUnitMessages(workUnitId: string): Promise<{ thawedMessages: number }> {
    return this.messagesStore.thawWorkUnitMessages(workUnitId);
  }

  // ─── 目录型实体（EntityStore）───

  getProfile(id: string): Promise<AgentProfileData | null> {
    return this.entityStore.getProfile(id);
  }

  listProfiles(filter?: { status?: string }): Promise<AgentProfileData[]> {
    return this.entityStore.listProfiles(filter);
  }

  createProfile(data: AgentProfileData): Promise<void> {
    return this.entityStore.createProfile(data);
  }

  updateProfile(id: string, patch: Partial<AgentProfileData>): Promise<void> {
    return this.entityStore.updateProfile(id, patch);
  }

  deleteProfile(id: string): Promise<void> {
    return this.entityStore.deleteProfile(id);
  }

  getState(agentId: string): Promise<RuntimeStateData | null> {
    return this.entityStore.getState(agentId);
  }

  listStates(): Promise<RuntimeStateData[]> {
    return this.entityStore.listStates();
  }

  createState(agentId: string, data: RuntimeStateData): Promise<void> {
    return this.entityStore.createState(agentId, data);
  }

  updateState(agentId: string, patch: Partial<RuntimeStateData>): Promise<void> {
    return this.entityStore.updateState(agentId, patch);
  }

  deleteState(agentId: string): Promise<void> {
    return this.entityStore.deleteState(agentId);
  }

  sweepEmptyAgentDirs(): Promise<{ removed: number }> {
    return this.entityStore.sweepEmptyAgentDirs();
  }

  getChannel(id: string): Promise<ChannelData | null> {
    return this.entityStore.getChannel(id);
  }

  listChannels(filter?: { name?: string; type?: string; excludeArchived?: boolean }): Promise<ChannelData[]> {
    return this.entityStore.listChannels(filter);
  }

  createChannel(data: ChannelData): Promise<void> {
    return this.entityStore.createChannel(data);
  }

  updateChannel(id: string, patch: Partial<ChannelData>): Promise<void> {
    return this.entityStore.updateChannel(id, patch);
  }

  deleteChannel(id: string): Promise<void> {
    return this.entityStore.deleteChannel(id);
  }

  // ─── 序号分配型条目（EntityStore 序号段）───

  allocateRequirementSeq(): Promise<number> {
    return this.entityStore.allocateRequirementSeq();
  }

  createRequirement(data: RequirementData): Promise<void> {
    return this.entityStore.createRequirement(data);
  }

  getRequirement(id: string): Promise<RequirementData | null> {
    return this.entityStore.getRequirement(id);
  }

  listRequirements(filter?: RequirementFilter): Promise<RequirementData[]> {
    return this.entityStore.listRequirements(filter);
  }

  updateRequirement(id: string, patch: Partial<RequirementData>): Promise<RequirementData> {
    return this.entityStore.updateRequirement(id, patch);
  }

  allocateEvolutionSeq(): Promise<number> {
    return this.entityStore.allocateEvolutionSeq();
  }

  createEvolutionProposal(data: EvolutionProposalData): Promise<void> {
    return this.entityStore.createEvolutionProposal(data);
  }

  getEvolutionProposal(id: string): Promise<EvolutionProposalData | null> {
    return this.entityStore.getEvolutionProposal(id);
  }

  listEvolutionProposals(filter?: EvolutionProposalFilter): Promise<EvolutionProposalData[]> {
    return this.entityStore.listEvolutionProposals(filter);
  }

  updateEvolutionProposal(id: string, patch: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
    return this.entityStore.updateEvolutionProposal(id, patch);
  }

  // ─── 扁平目录清单 / Markdown 文档（DocsStore）───

  listJsonInDir<T>(dir: string): Promise<T[]> {
    return this.docsStore.listJsonInDir<T>(dir);
  }

  readDoc(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string } | null> {
    return this.docsStore.readDoc(dir, key);
  }

  readDocWithMtime(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    return this.docsStore.readDocWithMtime(dir, key);
  }

  writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void> {
    return this.docsStore.writeDoc(dir, key, meta, body);
  }

  deleteDoc(dir: string, key: string): Promise<void> {
    return this.docsStore.deleteDoc(dir, key);
  }

  buildIndex(dir: string, fields: string[]): Promise<void> {
    return this.docsStore.buildIndex(dir, fields);
  }

  listDocs(dir: string): Promise<string[]> {
    return this.docsStore.listDocs(dir);
  }

  appendChangelog(dir: string, key: string, entry: string): Promise<void> {
    return this.docsStore.appendChangelog(dir, key, entry);
  }
}
