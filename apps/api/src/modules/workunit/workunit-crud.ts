/**
 * WorkUnit CRUD + Claim 持久化层 —— WorkUnitService 的基类（自 workunit.service.ts 拆分，纯代码移动）。
 *
 * AS-025 §3.28c-1 Task 2-4
 * 存储迁移: 已从 Prisma 迁移到 FileStore (Event Sourcing)
 *
 * 本文件：create/update/delete + claim/unclaim、workunit.created 与
 * workunit.status_changed 事件发布、父状态聚合（aggregateParentStatus），
 * 以及快照转换函数与输入/数据类型。状态机迁移（transitionStatus）、
 * 查询（getById/list）与评审验收收口在 workunit.service.ts 的 WorkUnitService。
 */

import { randomUUID } from 'crypto';
import { logger, eventBus, FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { ChannelMessageService, channelMessageService } from '../channels/channel-message.service.js';
import { resolveOrNotice, ROUTING_STAGE_LABELS } from '../channels/routing.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { resolveInitialStatus, WU_LEASE_TTL_MS } from './workunit.types.js';
import { buildStatusById, resolveClaimable } from './wu-dependencies.js';
import { parseWuPmoId } from '../requirements/wu-pmo-attribution.js';
import type { WorkUnitMetadata } from './workunit.service.js';

export interface CreateWorkUnitInput {
  type?: string;
  scope: string;
  assigneeId?: string;
  status?: string;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  workspaceId?: string | null;  // F6: 绑定工程（显式指定或频道默认）
  reqId?: string | null;        // REQ 需求编号（vision §5.3：显式/#REQ-XXXX/自动新建）
  failureType?: string;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

export interface UpdateWorkUnitInput {
  type?: string;
  scope?: string;
  assigneeId?: string | null;
  channelId?: string | null;
  parentId?: string | null;
  projectPath?: string | null;
  workspaceId?: string | null;
  reqId?: string | null;        // REQ 需求编号
  failureType?: string | null;
  retryCount?: number;
  timeoutAt?: Date | null;
  completedAt?: Date | null;
  metadata?: WorkUnitMetadata;
}

/**
 * WorkUnitData — 与 Prisma WorkUnit 类型兼容的平面字段（无 relations）。
 * 日期字段使用 Date 对象（与 Prisma 行为一致），来源是 FileStore 的字符串日期。
 */
export interface WorkUnitData {
  id: string;
  parentId: string | null;
  type: string;
  scope: string;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: Date | null;
  channelId: string | null;
  projectPath: string | null;
  workspaceId?: string | null;  // F6: 绑定工程（旧 WorkUnit 无此字段 → null）
  reqId?: string | null;        // REQ 需求编号（旧 WorkUnit 无此字段 → null）
  assigneeRoleId?: string | null;  // 认领时冗余的认领方 roleId 快照（旧 WorkUnit 无此字段 → null）
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}

/**
 * #178（2026-08-16，#63 决议 1）：claim 租约化 —— timeoutAt = 固定 5min 租约
 * （WU_LEASE_TTL_MS，常量在 workunit.types.ts），持有方 loop 每 30s 心跳推前；
 * 废除按 type 的 30/60min 预算默认值、metadata.timeoutAt 显式值优先与「已有列值不动」
 * （租约语义下认领即发新租约；任务预算归 maxTurns + token 记账，#54）。
 */

// ── 转换函数 ──

export function snapshotToData(s: WorkUnitSnapshot): WorkUnitData {
  return {
    id: s.id,
    parentId: s.parentId,
    type: s.type,
    scope: s.scope,
    assigneeId: s.assigneeId,
    status: s.status,
    failureType: s.failureType,
    retryCount: s.retryCount,
    timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
    channelId: s.channelId,
    projectPath: s.projectPath,
    workspaceId: s.workspaceId ?? null,
    reqId: s.reqId ?? null,
    assigneeRoleId: s.assigneeRoleId ?? null,
    metadata: s.metadata,
    createdAt: new Date(s.createdAt),
    updatedAt: new Date(s.updatedAt),
    claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
    completedAt: s.completedAt ? new Date(s.completedAt) : null,
  };
}

function inputToSnapshot(
  id: string,
  input: CreateWorkUnitInput,
  now: Date,
): WorkUnitSnapshot {
  const isoNow = now.toISOString();
  return {
    id,
    parentId: input.parentId ?? null,
    type: input.type ?? 'task',
    scope: input.scope,
    assigneeId: input.assigneeId ?? null,
    // #126（T4）：扩范围类型（feature/task/spec）未显式给 status 时默认落 pending（待确认人闸）
    status: resolveInitialStatus(input.type ?? 'task', input.status),
    failureType: input.failureType ?? null,
    retryCount: input.retryCount ?? 0,
    timeoutAt: input.timeoutAt?.toISOString() ?? null,
    channelId: input.channelId ?? null,
    projectPath: input.projectPath ?? null,
    workspaceId: input.workspaceId ?? null,
    reqId: input.reqId ?? null,
    assigneeRoleId: null,  // 认领快照仅在 claim 时写入（create 无认领方 roleId 来源）
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: isoNow,
    updatedAt: isoNow,
    claimedAt: null,
    completedAt: input.completedAt?.toISOString() ?? null,
  };
}

function patchSnapshot(
  existing: WorkUnitSnapshot,
  input: UpdateWorkUnitInput,
  now: Date,
): WorkUnitSnapshot {
  const isoNow = now.toISOString();
  return {
    ...existing,
    type: input.type ?? existing.type,
    scope: input.scope ?? existing.scope,
    assigneeId: input.assigneeId !== undefined ? input.assigneeId : existing.assigneeId,
    // 一致性规则：显式释放（assigneeId: null）连带清 roleId 认领快照，不留悬空的旧 roleId
    assigneeRoleId: input.assigneeId === null ? null : existing.assigneeRoleId ?? null,
    channelId: input.channelId !== undefined ? input.channelId : existing.channelId,
    parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
    projectPath: input.projectPath !== undefined ? input.projectPath : existing.projectPath,
    workspaceId: input.workspaceId !== undefined ? input.workspaceId : existing.workspaceId ?? null,
    reqId: input.reqId !== undefined ? input.reqId : existing.reqId ?? null,
    failureType: input.failureType !== undefined ? input.failureType : existing.failureType,
    retryCount: input.retryCount ?? existing.retryCount,
    timeoutAt: input.timeoutAt !== undefined ? input.timeoutAt?.toISOString() ?? null : existing.timeoutAt,
    completedAt: input.completedAt !== undefined ? input.completedAt?.toISOString() ?? null : existing.completedAt,
    metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : existing.metadata,
    updatedAt: isoNow,
  };
}

export class WorkUnitCrudService {
  protected fileStore: FileStore;
  protected messageService: ChannelMessageService;

  constructor(fileStore?: FileStore, messageService?: ChannelMessageService) {
    this.fileStore = fileStore ?? new FileStore();
    // #333：关联 WU 走 ChannelMessageService 统一更新路径（自带 channel.message_updated 双发）；
    // 注入口径：可注入；缺省 fileStore 新建 ChannelMessageService，无 fileStore 用单例
    this.messageService = messageService ?? (fileStore ? new ChannelMessageService(fileStore) : channelMessageService);
  }

  /**
   * #402 归因传播：带 parentId 的建单，显式 metadata 未带归因戳（pmoId ‖ legacy
   * ownershipProjectId 同级）时从父 WU 继承，legacy 归一为 canonical pmoId。
   * 创建期一次性落档语义不变——只在建单瞬间补齐可推导归属，此后不再改写；
   * 显式传入优先，父缺失/无戳则不动（无归属 WU 合法存在，不伪造）。
   */
  private async inheritParentPmoId(input: CreateWorkUnitInput): Promise<CreateWorkUnitInput> {
    if (!input.parentId) return input;
    if (parseWuPmoId(input.metadata ? JSON.stringify(input.metadata) : null)) return input;
    const parent = (await this.fileStore.getIndex({ id: input.parentId }))[0];
    const stamp = parent ? parseWuPmoId(parent.metadata) : null;
    if (!stamp) return input;
    return { ...input, metadata: { ...input.metadata, pmoId: stamp } };
  }

  /**
   * Create a new WorkUnit.
   */
  async create(input: CreateWorkUnitInput): Promise<WorkUnitData> {
    input = await this.inheritParentPmoId(input);
    const id = randomUUID();
    const now = new Date();
    const snapshot = inputToSnapshot(id, input, now);

    // #170（决策 #65-3）：appendEvent + upsertSnapshot 同一把 flock 成对落盘
    const event: WorkUnitEvent = {
      type: 'created',
      wuId: id,
      timestamp: now.toISOString(),
      data: snapshot as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, snapshot);

    // Publish event for EVENT trigger consumers (AgentLoop, etc.)
    await this.publishCreated(snapshot);

    const parentWu = snapshotToData(snapshot);

    // #464：pending = 待确认人闸——落闸即频道出声（此前唯一入口是 WU 列表统计 chip，
    // 角色不动工用户无感知）。milestone 形态：atHuman 响铃 + #468 行动中心通知双写，
    // 与状态派生的 confirm 段（action-center）同源不重复（事件持久面 + 状态派生面各司其职）。
    if (parentWu.status === 'pending' && parentWu.channelId) {
      await postWuSystemMessage(
        parentWu,
        `新工单「${parentWu.scope.slice(0, 50)}」已进入待确认（人闸）——在工单列表/详情点「确认」后才会派工`,
        { milestone: true, fileStore: this.fileStore },
      ).catch(err =>
        logger.warn('[WorkUnit] pending gate notice failed (non-blocking)', {
          workUnitId: parentWu.id,
          error: String(err),
        }),
      );
    }

    // #466: 频道工单路由展开（吞并 AC-6.3 defaultPipeline；D10: 只展开第一跳，后续靠 agent DELEGATE）
    // #126（T4）：feature 落 pending（待确认人闸）时不展开——确认（pending→unassigned）
    // 时由 transitionStatus 补展开，避免未确认需求先烧 token。
    if (input.type === 'feature' && input.channelId && parentWu.status === 'unassigned') {
      await this.expandRoutingHead(parentWu).catch(err =>
        logger.warn('[WorkUnit] routing expansion failed (non-blocking)', {
          parentId: parentWu.id,
          error: String(err),
        }),
      );
    }

    return parentWu;
  }

  /**
   * #170（决策 #65-2）：锁内 check-then-create 建单——guard 在 workunits flock 内对
   * 最新 index 复查，通过才落 created 事件 + 索引快照（并发下同守卫建单只有一个成功）。
   * 供 ReviewDispatcher 的同父唯一性建单使用；不做默认管线展开（guard 型调用方非 feature 链头）。
   * @returns 建单成功返回 WorkUnitData；guard 拒绝返回 null（未落任何数据）
   */
  async createGuarded(
    input: CreateWorkUnitInput,
    guard: (snapshots: WorkUnitSnapshot[]) => boolean,
  ): Promise<WorkUnitData | null> {
    input = await this.inheritParentPmoId(input);
    const id = randomUUID();
    const now = new Date();
    const snapshot = inputToSnapshot(id, input, now);

    const created = await this.fileStore.createSnapshotGuarded(snapshot, guard);
    if (!created) return null;

    await this.publishCreated(snapshot);
    return snapshotToData(snapshot);
  }

  /**
   * #318（SSE 负载深化 additive，ADR D2）：事件负载附 claimable 标记，口径与 GET / 列表路由一致——
   * unassigned 且无未了结依赖才 true；其余状态恒 false 且不读 index。前端列表据此负载直更「被阻塞」徽标。
   */
  private async resolveEventClaimable(snapshot: WorkUnitSnapshot): Promise<boolean> {
    if (snapshot.status !== 'unassigned') return false;
    const statusById = buildStatusById(await this.fileStore.getIndex());
    return resolveClaimable(snapshot, statusById);
  }

  /** workunit.created 发布（best-effort，不阻断主流程；create/createGuarded 共用） */
  private async publishCreated(snapshot: WorkUnitSnapshot): Promise<void> {
    try {
      const claimable = await this.resolveEventClaimable(snapshot);
      eventBus.publish('workunit.created', { workunit: { ...snapshotToData(snapshot), claimable } });
    } catch (err) {
      logger.warn('[WorkUnit] Failed to publish workunit.created (non-blocking)', {
        workUnitId: snapshot.id,
        error: String(err),
      });
    }
  }

  /**
   * #466（吞并 AC-6.3 + D10）：展开频道工单路由的第一跳。
   * 仅 type='feature' 父 WU 触发；routing.implement 配置的角色作为链头子 WU 指名人，
   * 后续跳由 agent DELEGATE 协议接管（不全链路代码展开）。
   * 未配置 implement 档 → 不展开（父单留池涌现）；
   * 配置了但角色 inactive/被移出频道 → 不展开（回池涌现）+ 频道出声提醒（票体回退语义）。
   * #126（T4）：幂等——父单已有任何子单则跳过（create 与确认后补展开两处调用点）。
   */
  protected async expandRoutingHead(parent: WorkUnitData): Promise<void> {
    // #477：解析 + fallback 判定 + 文案收口到 resolveOrNotice；出声通道/时机留本点
    const { resolution: routing, notice } = await resolveOrNotice(this.fileStore, parent.channelId!, 'implement', {
      // #464：未配置也要出声——此前未配置静默 return，用户分不清「只配一跳」还是「断了」。
      // 文案与配错（routingFallbackText）同形态可区分；非里程碑（路由提醒不打扰，对齐配错提醒形态）。
      notConfiguredText: `工单路由提示：本频道未配置「${ROUTING_STAGE_LABELS.implement}」阶段路由，本单已回池涌现（频道成员自动认领）——如需固定角色派工请到频道设置配置路由表，或手动拆单`,
    });
    if (!routing.profileId) {
      if (routing.fallback) {
        logger.warn('[WorkUnit] routing.implement 配置不可用，回池涌现', {
          parentId: parent.id,
          fallback: routing.fallback,
          profileName: routing.profileName,
        });
      }
      if (notice) {
        await postWuSystemMessage(parent, notice, {
          fileStore: this.fileStore,
        }).catch(err =>
          logger.warn('[WorkUnit] routing notice failed (non-blocking)', {
            parentId: parent.id,
            error: String(err),
          }),
        );
      }
      return;
    }

    const existing = await this.fileStore.getIndex();
    if (existing.some(s => s.parentId === parent.id)) return;

    const firstProfile = await this.fileStore.getProfile(routing.profileId);
    if (!firstProfile) return; // 解析与建单间的竞态（角色刚被删）——按不展开处理

    const childMeta: WorkUnitMetadata = {
      collab: {
        rootId: parent.id,
        depth: 1,
        chain: [firstProfile.id],
        delegatedBy: { profileId: parent.assigneeId ?? '', workUnitId: parent.id },
        delegationCount: 0,
      },
    };

    // 递归 create：子 WU type=阶段名（profile.acceptedTypes[0]，缺省 'task'；原为角色名，决策 10 语义清理）。
    // type 非 'feature'，不会再次触发展开
    await this.create({
      type: firstProfile.acceptedTypes?.[0] ?? 'task',
      scope: parent.scope,
      assigneeId: firstProfile.id,
      status: 'unassigned',
      channelId: parent.channelId,
      parentId: parent.id,
      workspaceId: parent.workspaceId ?? null,
      reqId: parent.reqId ?? null,
      metadata: childMeta,
    });
  }

  /**
   * Convert a ChannelMessage to a WorkUnit (emergence path).
   * Links the source message to the new WorkUnit via workUnitId.
   * #524 P1-1（#514 定案）：options.channelId 由上游路由透传 → 按频道直查，
   * 消灭最后一个全频道扫描反查；缺省保留扇出兼容（无频道上下文的冷调用）。
   * @throws Error if message not found or already converted
   */
  async createFromMessage(
    messageId: string,
    options?: { type?: string; metadata?: WorkUnitMetadata; channelId?: string },
  ): Promise<WorkUnitData> {
    const found = await this.fileStore.getMessageById(messageId, options?.channelId);
    if (!found) throw new Error(`Message ${messageId} not found`);
    if (found.message.workUnitId) throw new Error(`Message already linked to WorkUnit ${found.message.workUnitId}`);

    const wu = await this.create({
      scope: found.message.content.slice(0, 500),
      type: options?.type ?? 'task',
      channelId: found.message.channelId,
      metadata: {
        ...options?.metadata,
        sourceMessageId: messageId,
        creationMode: 'from-message',
      },
    });

    // Link message to WorkUnit —— #333：经 ChannelMessageService 统一更新路径
    // （append 新版保留原 createdAt，自带 eventBus + SSE channel.message_updated 双发）
    await this.messageService.linkWorkUnit(messageId, wu.id, found.channelId);

    return wu;
  }

  /**
   * Update a WorkUnit.
   */
  async update(id: string, input: UpdateWorkUnitInput): Promise<WorkUnitData> {
    const existing = (await this.fileStore.getIndex({ id }))[0];
    if (!existing) throw new Error(`WorkUnit not found: ${id}`);

    const now = new Date();
    const updated = patchSnapshot(existing, input, now);

    // #170（决策 #65-3）：appendEvent + upsertSnapshot 同锁成对
    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: id,
      timestamp: now.toISOString(),
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);

    return snapshotToData(updated);
  }

  /**
   * Delete a WorkUnit.
   */
  async delete(id: string): Promise<void> {
    const existing = (await this.fileStore.getIndex({ id }))[0];
    if (!existing) throw new Error(`WorkUnit not found: ${id}`);

    const now = new Date();

    // #170（决策 #65-3）：删除墓碑事件 + 索引移除同锁成对——
    // data.deleted=true 墓碑让 rebuildIndex/reconcileIndex 不复活已删 WU
    const event: WorkUnitEvent = {
      type: 'closed',
      wuId: id,
      timestamp: now.toISOString(),
      data: { deleted: true },
    };
    await this.fileStore.commitRemoval(event, id);
  }

  /**
   * Check if the WorkUnit's files overlap with any active WorkUnit's files.
   * Files stored in metadata.files (string[]).
   * @returns array of conflicting WorkUnit IDs (empty if no conflict)
   */
  private async checkFileConflicts(id: string, metadataRaw: string | null): Promise<string[]> {
    if (!metadataRaw) return [];
    let meta: WorkUnitMetadata;
    try {
      meta = JSON.parse(metadataRaw) as WorkUnitMetadata;
    } catch {
      // 元数据损坏按无文件列表处理，不阻断 claim
      return [];
    }
    const files = meta.files;
    if (!files || !Array.isArray(files) || files.length === 0) return [];

    const fileSet = new Set(files);
    const activeSnapshots = await this.fileStore.getIndex({
      status: 'active',
    });
    const reviewSnapshots = await this.fileStore.getIndex({
      status: 'in_review',
    });
    const activeWorkUnits = [...activeSnapshots, ...reviewSnapshots].filter(s => s.id !== id);

    const conflicts: string[] = [];
    for (const wu of activeWorkUnits) {
      if (!wu.metadata) continue;
      const wuMeta: WorkUnitMetadata = JSON.parse(wu.metadata);
      const wuFiles = wuMeta.files;
      if (!Array.isArray(wuFiles)) continue;
      const hasOverlap = wuFiles.some(f => fileSet.has(f));
      if (hasOverlap) conflicts.push(wu.id);
    }
    return conflicts;
  }

  /**
   * Claim a WorkUnit（flock 悲观互斥锁，mkdir 原子目录跨进程互斥；非乐观锁——
   * 无版本号/读后再验，冲突在锁内以 status!=='unassigned' 拒绝）。
   * Only succeeds when status is 'unassigned' — file-store.claimWorkUnit 不校验
   * 既有 assigneeId，认领成功会把 assigneeId 改写为认领方（loop 传入 instance.id）。
   * mention 指名（assigneeId=profile id）的可见性由 AgentLoop.observe 的
   * unassigned 过滤保证（仅被指名 profile 的 loop 可见），而非 claim 本身。
   * 决策 7: skill 匹配/注入在 agent-loop step 时进行，claim 不再触发 skill 加载。
   * @throws Error if claim fails (already claimed or invalid state)
   */
  async claim(id: string, agentId: string): Promise<WorkUnitData> {
    logger.info(`[WorkUnit] Claiming WorkUnit: ${id} by agent ${agentId}`);

    // Read current state
    const wuToClaim = (await this.fileStore.getIndex({ id }))[0];
    if (!wuToClaim) throw new Error('WorkUnit not found');

    // File conflict check before claiming
    const conflicts = await this.checkFileConflicts(id, wuToClaim.metadata);
    if (conflicts.length > 0) {
      throw new Error(`File conflict with WorkUnit(s): ${conflicts.join(', ')}`);
    }

    // Use flock-based claim
    // 认领方是运行实例时取其 roleId 冗余快照到 WU（实例回收后展示层仍能解析角色名）；
    // 人工 REST 认领 agentId=用户 id，getState 落空 → null（回退短 UUID，与既有表现一致）
    const assigneeRoleId = (await this.fileStore.getState(agentId))?.roleId ?? null;
    const claimed = await this.fileStore.claimWorkUnit(id, agentId, { assigneeRoleId });
    if (!claimed) {
      throw new Error('Claim failed');
    }

    // Re-read after claim
    const wu = (await this.fileStore.getIndex({ id }))[0];
    if (!wu) throw new Error('WorkUnit not found');

    // 决策 7: skill 匹配已从 claim 挪到 agent-loop step 时（消竞态、吃到 skill 库最新版），
    // claim 不再做 skill 自动加载/落盘。
    // #178（#63 决议 1）：租约制 —— 认领即写固定 5min 租约 timeoutAt（workunit-timeout
    // 扫描的判定字段；已有列值/显式 metadata 值一律刷新，租约语义下认领即发新租约）。
    // 持有期间由 loop 30s 心跳经 refreshWorkUnitLease 推前（agents/loop/lease-heartbeat）。
    const timeoutAt = new Date(Date.now() + WU_LEASE_TTL_MS);
    await this.update(id, { timeoutAt });
    wu.timeoutAt = timeoutAt.toISOString();
    // 认领即状态变化（unassigned → active）：补发 status_changed（WU 列表实时刷新/接力订阅消费）
    await this.publishStatusChanged(wu);
    return snapshotToData(wu);
  }

  /**
   * Unclaim a WorkUnit. Resets to unassigned state.
   */
  async unclaim(id: string): Promise<WorkUnitData> {
    const existing = (await this.fileStore.getIndex({ id }))[0];
    if (!existing) throw new Error(`WorkUnit not found: ${id}`);

    const now = new Date();
    const updated: WorkUnitSnapshot = {
      ...existing,
      assigneeId: null,
      assigneeRoleId: null,  // 释放连带清认领快照（事件 data 是全量快照，rebuild 自动一致）
      status: 'unassigned',
      claimedAt: null,
      updatedAt: now.toISOString(),
    };

    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: id,
      timestamp: now.toISOString(),
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);

    // 释放回池（→ unassigned）同样发 status_changed（列表实时刷新/重新派工可见）
    await this.publishStatusChanged(updated);

    return snapshotToData(updated);
  }

  /**
   * 发布 workunit.status_changed（best-effort，不阻断主流程）。
   * REQ 需求状态汇总（vision §5.3）等订阅方消费。
   * #318：负载附 claimable（additive，见 resolveEventClaimable）。
   */
  protected async publishStatusChanged(snapshot: WorkUnitSnapshot): Promise<void> {
    try {
      const claimable = await this.resolveEventClaimable(snapshot);
      eventBus.publish('workunit.status_changed', { workunit: { ...snapshotToData(snapshot), claimable } });
    } catch (err) {
      logger.warn('[WorkUnit] Failed to publish workunit.status_changed (non-blocking)', {
        workUnitId: snapshot.id,
        error: String(err),
      });
    }
  }

  /**
   * Compute aggregated parent status from children statuses.
   * Returns null if no change needed.
   */
  private computeAggregatedStatus(statuses: string[]): string | null {
    if (statuses.every(s => s === 'unassigned')) return 'unassigned';
    if (statuses.some(s => s === 'blocked')) return 'blocked';
    if (statuses.some(s => s === 'active')) return 'active';
    if (statuses.every(s => s === 'done' || s === 'closed') && statuses.some(s => s === 'done')) return 'in_review';
    if (statuses.every(s => s === 'closed')) return 'closed';
    return null;
  }

  /**
   * Cascade: aggregate parent WorkUnit status from children.
   * Called after a child's status changes.
   *
   * Aggregation rules (ordered):
   *  - All children unassigned → parent unassigned
   *  - Any child blocked → parent blocked
   *  - Any child active → parent active
   *  - All done/closed (≥1 done) → parent in_review
   *  - All closed → parent closed
   *
   * Only applies to organizational parents (children exist).
   * Skips if parent doesn't exist.
   */
  async aggregateParentStatus(childId: string): Promise<void> {
    const snapshots = await this.fileStore.getIndex();
    const child = snapshots.find(s => s.id === childId);
    if (!child?.parentId) return;

    // Re-read children right before update to avoid stale overwrites
    const siblings = snapshots.filter(s => s.parentId === child.parentId);
    if (siblings.length === 0) return;

    const newStatus = this.computeAggregatedStatus(siblings.map(s => s.status));
    if (!newStatus) return;

    const parent = snapshots.find(s => s.id === child.parentId);
    if (!parent || parent.status === newStatus) return;

    // #126（T4）：pending = 待确认人闸，只能人工确认（pending→unassigned）解除，
    // 子单聚合不覆盖（否则子单 active 会顶掉人闸）。
    if (parent.status === 'pending') return;

    // State ordering guard: don't overwrite a parent that's already at a "later" state.
    const ORDER: Record<string, number> = { unassigned: 0, active: 1, blocked: 2, in_review: 3, done: 4, closed: 5 };
    if ((ORDER[parent.status] ?? 0) >= (ORDER[newStatus] ?? 0)) return;

    const now = new Date().toISOString();
    const updatedParent: WorkUnitSnapshot = {
      ...parent,
      status: newStatus,
      updatedAt: now,
    };

    const event: WorkUnitEvent = {
      type: 'updated',
      wuId: child.parentId,
      timestamp: now,
      data: updatedParent as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updatedParent);

    logger.info('[WorkUnit] Parent status aggregated', {
      parentId: child.parentId,
      newStatus,
      childCount: siblings.length,
    });
  }

}
