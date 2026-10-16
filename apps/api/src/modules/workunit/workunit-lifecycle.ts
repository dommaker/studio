/**
 * WorkUnit 状态机层 —— WorkUnitLifecycleService（#672 自 workunit.service.ts 拆分，纯代码移动）。
 *
 * 本层：状态机迁移（transitionStatus）、系统侧关闭唯一入口（close，#550 收编 wu-closure）、
 * 迁移类写路径唯一落库尾部 persistSnapshot（#550 扩面，评审层共用，故为 protected）、
 * 频道删除兜底 rebindSourceChannel。
 * 查询在 workunit-query.ts（基类），评审验收在 workunit-review.ts（子类）。
 */

import { logger, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveValidTransitions, WORKUNIT_CLOSED_EVENT_TYPE, type WorkUnitMetadata, type CloseWorkUnitOptions } from './workunit.types.js';
import { snapshotToData, type WorkUnitData } from './workunit-crud.js';
import { WorkUnitQueryService } from './workunit-query.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { writeStudioEvent } from '@dommaker/studio-shared';
import { recordAgentDecision, type AuditActor } from '../audit-logs/index.js';

export class WorkUnitLifecycleService extends WorkUnitQueryService {

  /**
   * Transition WorkUnit status with state machine validation.
   * #591：actor 可选透传给流转埋点（REST 人工流转传 human；缺省在 persistSnapshot
   * 尾部按 assigneeId 命中 agent 状态库派生）。
   * @throws Error if transition is not allowed
   */
  async transitionStatus(id: string, newStatus: string, actor?: AuditActor): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) {
      throw new Error('WorkUnit not found');
    }

    // #108：decision/spec 走裁剪状态机（TYPE_VALID_TRANSITIONS 覆盖），其余 type 用全局表
    const allowed = resolveValidTransitions(current.type, current.status);
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: ${current.status} → ${newStatus}`
      );
    }

    const eventType: WorkUnitEvent['type'] =
      newStatus === 'done' || newStatus === 'closed' ? 'completed' :
      newStatus === 'blocked' ? 'blocked' : 'updated';

    // #176（决策 #57 D4）：转入 blocked 统一落死信计时基准 metadata.blockedAt
    // （24h 自动关闭与 30min 提醒均以此为锚；复活后再次 blocked 刷新）；
    // 非 blocked 迁移不动 metadata（原串透传，见 persistSnapshot 口径）
    const metadata: WorkUnitMetadata | string | null = newStatus === 'blocked'
      ? { ...parseWuMetadata(current.metadata), blockedAt: new Date().toISOString() }
      : current.metadata;

    // #550：closedAt/completedAt 落锚、status_changed 发布、父聚合、reopen thaw 全在统一尾部
    const updated = await this.persistSnapshot(current, metadata, {
      eventType,
      status: newStatus,
      markCompleted: newStatus === 'done' || newStatus === 'closed',
      auditActor: actor,
    });

    // #126（T4）：人工确认（pending → unassigned）解除人闸——feature 单此时补展开
    // 频道工单路由第一跳（创建时落 pending 跳过展开；expandRoutingHead 幂等）。
    if (current.status === 'pending' && newStatus === 'unassigned'
      && updated.type === 'feature' && updated.channelId) {
      await this.expandRoutingHead(snapshotToData(updated)).catch(err =>
        logger.warn('[WorkUnit] routing expansion on confirm failed (non-blocking)', {
          parentId: updated.id,
          error: String(err),
        }),
      );
    }

    return snapshotToData(updated);
  }

  /**
   * #550：系统侧关闭唯一入口——与手工 PATCH 同走状态机校验 + 统一落库尾部
   * （closedAt/completedAt 落锚 + status_changed 广播 + 父聚合），随后双出声
   * （#176 决策 #62 §3）：workunit:closed 结构化事件（payload 与 wu-closure 时代一致）
   * + 频道里程碑说明，各步 best-effort。
   * decision/spec 裁剪状态机无 closed → resolveValidTransitions 天然拒绝
   * （守卫不再散落调用方手写查表）。
   * 幂等：目标已是 closed → 直返现状，不重复发事件/广播/出声（巡检探针撞上已关单是
   * 常态，与 blockForManualRelease 终态不动先例一致）。
   */
  async close(id: string, opts: CloseWorkUnitOptions): Promise<WorkUnitData> {
    const current = (await this.fileStore.getIndex({ id }))[0];
    if (!current) throw new Error('WorkUnit not found');
    if (current.status === 'closed') return snapshotToData(current);

    const allowed = resolveValidTransitions(current.type, current.status);
    if (!allowed || !allowed.includes('closed')) {
      throw new Error(`Invalid status transition: ${current.status} → closed`);
    }

    // metadata 原串透传（关闭不动 metadata，与 wu-closure 直写口径一致；blockedAt 由事件发射处另解析）
    const updated = await this.persistSnapshot(current, current.metadata, {
      eventType: 'completed',
      status: 'closed',
      markCompleted: true,
      // #591：closedBy 映射埋点主体——human-command 是人指令；系统看守（超时强杀/死信等）记 agent 自主
      auditActor: { id: opts.closedBy, type: opts.closedBy === 'human-command' ? 'human' : 'agent' },
    });

    await this.writeWorkUnitClosedEvent(current, opts, updated.closedAt ?? updated.updatedAt);

    if (current.channelId) {
      await postWuSystemMessage(snapshotToData(updated), opts.message ?? opts.reason, {
        milestone: true,
        fileStore: this.fileStore,
      }).catch(err =>
        logger.warn('[WorkUnit] Close channel notice failed (non-blocking)', { workUnitId: id, error: String(err) })
      );
    }

    return snapshotToData(updated);
  }

  /** workunit:closed 结构化事件（level=warning，对齐 workunit:failed 分级；fire-and-forget） */
  private async writeWorkUnitClosedEvent(
    snapshot: WorkUnitSnapshot,
    opts: CloseWorkUnitOptions,
    closedAt: string,
  ): Promise<void> {
    try {
      const blockedAt = parseWuMetadata(snapshot.metadata).blockedAt;
      await writeStudioEvent(WORKUNIT_CLOSED_EVENT_TYPE, {
        workUnitId: snapshot.id,
        reason: opts.reason,
        closedBy: opts.closedBy,
        ...(typeof blockedAt === 'string' ? { blockedAt } : {}),
        closedAt,
      }, { source: 'wu-closure', level: 'warning' });
    } catch (err) {
      logger.warn('[WorkUnit] Closed event emit failed (non-blocking)', { workUnitId: snapshot.id, error: String(err) });
    }
  }

  /**
   * 迁移类写路径的唯一落库尾部（#550 扩面：原仅评审/验证路径，现覆盖 transitionStatus /
   * close / markMergeConflict / blockForManualRelease / blockForAllUnfit 全部迁移类写）：
   * 构建 updated 快照（updatedAt=now；可选 status 覆盖 / markCompleted 置 completedAt=同一此刻 /
   * closedAt 落锚规则 / patch 额外字段覆盖）→ commitSnapshot（#170：appendEvent +
   * upsertSnapshot 同锁成对）→ publishStatusChanged → 父状态聚合（status ∈
   * active/blocked/done/closed 且未显式关闭时，fire-and-forget 同原 transitionStatus 先例）→
   * reopen（closed → unassigned）thaw 解冻。
   * 各调用方只保留自身策略：状态机/业务守卫、metadata 变更、事件类型、特有级联
   * （如 expandRoutingHead、合并触发）——新迁移入口不得再抄本尾部。
   * #672：private → protected，评审层（workunit-review.ts 子类）共用本尾部。
   */
  protected async persistSnapshot(
    current: WorkUnitSnapshot,
    metadata: WorkUnitMetadata | string | null,
    opts: {
      eventType: WorkUnitEvent['type'];
      status?: string;
      markCompleted?: boolean;
      /** 额外快照字段覆盖（如 blockForManualRelease 清 assigneeId/claimedAt） */
      patch?: Partial<WorkUnitSnapshot>;
      /** 父状态聚合开关；缺省 = status ∈ active/blocked/done/closed 时聚合 */
      aggregateParent?: boolean;
      /** #591：流转埋点主体透传；缺省按 assigneeId 命中 agent 状态库派生 */
      auditActor?: AuditActor;
    },
  ): Promise<WorkUnitSnapshot> {
    const isoNow = new Date().toISOString();
    const nextStatus = opts.status ?? current.status;
    // string/null 原样透传（调用方未动 metadata 时保持原字节，null 不归一为 '{}'）；
    // 对象形态由调用方做过策略变更，序列化落盘
    const metadataRaw: string | null = metadata === null
      ? null
      : typeof metadata === 'string'
        ? metadata
        : JSON.stringify(metadata);
    const updated: WorkUnitSnapshot = {
      ...current,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...opts.patch,
      metadata: metadataRaw,
      ...(opts.markCompleted ? { completedAt: isoNow } : {}),
      // #327：closedAt 是归档计龄锚点——转入 closed 落锚；从 closed 迁出（reopen，状态机唯一
      // 出口 closed→unassigned）清除，活 WU 的消息不按陈旧锚点被归档；其余迁移保持原值
      closedAt: nextStatus === 'closed' ? isoNow : current.status === 'closed' ? null : current.closedAt,
      updatedAt: isoNow,
    };
    const event: WorkUnitEvent = {
      type: opts.eventType,
      wuId: current.id,
      timestamp: isoNow,
      data: updated as unknown as Record<string, unknown>,
    };
    await this.fileStore.commitSnapshot(event, updated);
    await this.publishStatusChanged(updated);

    // #591：状态机流转埋点（决策词表 transition，落 audit-logs 轨）——仅真实状态迁移落账
    // （台账补写等无 status 变化的路径不落）；actor 缺省按 assigneeId 命中 agent 状态库派生；
    // traceId 取 WU metadata.traceId（与频道链路/audit requestId 同值口径）；fire-and-forget
    if (opts.status !== undefined && opts.status !== current.status) {
      let actor = opts.auditActor;
      if (!actor && updated.assigneeId) {
        const state = await this.fileStore.getState(updated.assigneeId).catch(() => null);
        if (state) actor = { id: updated.assigneeId, type: 'agent' };
      }
      recordAgentDecision({
        action: 'transition',
        resource: 'workunit',
        resourceId: current.id,
        actor,
        details: { from: current.status, to: opts.status, eventType: opts.eventType },
        requestId: parseWuMetadata(metadataRaw).traceId,
      });
    }

    // Cascade: parent status aggregation（fire-and-forget，与原 transitionStatus 先例一致）
    const shouldAggregate = opts.aggregateParent
      ?? (opts.status !== undefined && ['active', 'blocked', 'done', 'closed'].includes(nextStatus));
    if (shouldAggregate) {
      this.aggregateParentStatus(current.id).catch(err =>
        logger.warn('[WorkUnit] aggregateParentStatus failed', { workUnitId: current.id, error: String(err) })
      );
    }

    // #327：reopen（closed → unassigned）自动解冻——该 WU 已归档消息从冷文件搬回热文件，
    // 规则保持一条线：活 WU 的消息永远在热层。best-effort：失败记日志不阻断迁移
    if (current.status === 'closed' && nextStatus === 'unassigned') {
      await this.fileStore.thawWorkUnitMessages(current.id).catch(err =>
        logger.warn('[WorkUnit] Thaw archived messages on reopen failed (non-blocking)', {
          workUnitId: current.id, error: String(err),
        })
      );
    }

    return updated;
  }

  /**
   * 频道删除兜底（B2-012）：把 context.sourceChannelId === fromChannelId 的顶层 task WU
   * 重挂到 toChannelId，返回重绑数量。
   * 字段相等匹配（解析 metadata 后比对 context.sourceChannelId）——不做 raw JSON 子串匹配
   * （`metadata.includes(channelId)` 会误中其它字段恰好含同 id 的 WU）。
   * 空/损坏 metadata 跳过。metadata-only 更新沿用 update() 惯例：appendEvent('updated') +
   * upsertSnapshot，不发 status_changed（状态与证据均未变，无需 rollup 重估）。
   */
  async rebindSourceChannel(fromChannelId: string, toChannelId: string): Promise<number> {
    const snapshots = await this.fileStore.getIndex();
    let rebound = 0;
    for (const s of snapshots) {
      if (s.type !== 'task' || s.parentId !== null || !s.metadata) continue;
      // 损坏 metadata → {} → context 缺失自然不匹配（按无匹配处理）
      const meta = parseWuMetadata(s.metadata);
      // context 在 metadata 接口里声明为 legacy string 降级字段，但频道来源链路实际落的是对象
      // （{ sourceChannelId }，见原 channel delete 路由口径）——按运行时形态松散取值
      const raw = meta as Record<string, unknown>;
      const ctx = (raw.context ?? {}) as Record<string, unknown>;
      if (ctx.sourceChannelId !== fromChannelId) continue;
      ctx.sourceChannelId = toChannelId;
      raw.context = ctx;

      const now = new Date().toISOString();
      const updated: WorkUnitSnapshot = { ...s, metadata: JSON.stringify(meta), updatedAt: now };
      const event: WorkUnitEvent = {
        type: 'updated',
        wuId: s.id,
        timestamp: now,
        data: updated as unknown as Record<string, unknown>,
      };
      await this.fileStore.commitSnapshot(event, updated);
      rebound++;
    }
    if (rebound > 0) {
      logger.info('[WorkUnit] Rebound sourceChannelId', { fromChannelId, toChannelId, count: rebound });
    }
    return rebound;
  }
}
