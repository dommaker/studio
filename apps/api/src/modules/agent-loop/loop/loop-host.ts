/**
 * AgentLoop 段间宿主契约（#668 agent-loop.ts 按职责切深模块）。
 *
 * 拆分后各段模块（loop-lifecycle / loop-observe / loop-claim / loop-step /
 * loop-record-result）持有本接口引用（host），共享运行状态与跨段调用全部经此
 * 显式化——原 AgentLoop 类的 private 字段/互调方法的编译期形态，纯结构移动，
 * 不改运行时行为。AgentLoop 门面 implements 本接口；成员均为模块内部面，
 * 不经 index.ts 出模块（跨模块消费仍只走 barrel）。
 */
import type { AgentProfileData, FileStore } from '@dommaker/studio-shared';
import type { WorkUnitService, WorkUnitData, ExecutionJournal } from '../../workunit/index.js';
import type { MessageMeta } from '../../channels/index.js';
import type { Executor } from '../executor.js';
import type { WuLeaseTracker } from '../wu-lease.js';
import type { RuntimeInstanceRow } from '../agent-loop.types.js';

export interface AgentLoopHost {
  // ── 构造期依赖（只读） ──
  readonly role: AgentProfileData;
  readonly fileStore: FileStore;
  readonly workUnitService: WorkUnitService;
  readonly executionJournal: ExecutionJournal;
  readonly executor: Executor;
  readonly acceptedTypes: string[];
  /** #178（#63 决议 1/2，#209 smell 4 迁出）：租约/fencing 三件套 */
  readonly wuLease: WuLeaseTracker;
  /** B5：observe 回复检测的增量水位（channelId → messages.jsonl 字节偏移） */
  readonly replyScanWatermarks: Map<string, number>;

  // ── 运行时可变状态 ──
  instance: RuntimeInstanceRow | null;
  alive: boolean;
  triggerId: string | null;
  loopPromise: Promise<void> | null;
  /** #634: stop() 的 terminated 落盘写句柄 */
  terminateWrite: Promise<unknown> | null;
  lastIdleHeartbeatAt: number;
  /** #330：空闲 sleep 的中断器（idleSleep 挂起期间非 null） */
  wakeIdle: (() => void) | null;
  /** #330：channel.message_sent 订阅句柄（start 挂、stop 退） */
  messageSentHandler: ((payload: { message?: { authorType?: string; workUnitId?: string | null } }) => void) | null;
  /** #493：唤醒闩锁 */
  pendingWake: boolean;
  /** #523（#515 决议 P0-2）：workunit.status_changed 订阅句柄（start 挂、stop 退） */
  workunitChangedHandler: ((payload: unknown) => void) | null;
  /** 2026-07 PMO-flow UX（§6-2）：最后一次已发布的 instance 状态（SSE 去重） */
  lastPublishedStatus: string | null;
  /** #178（#63 决议 2）：当前步 executionId——易主时据此经 Executor 杀自身 CLI 进程组 */
  currentExecutionId: string | null;
  /** #179（#66 决议 3 loop 侧）：实例心跳写连败计数 */
  consecutiveHeartbeatFailures: number;

  // ── 跨段方法（实现留 AgentLoop 门面委托，各段经此互调，不经深路径互 import） ──
  /** 主循环（编排本体留 agent-loop.ts 门面） */
  runLoop(): Promise<void>;
  /** #330/#493：channel.message_sent 唤醒过滤 + 闩锁（观察段实现） */
  onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void;
  /** #523：workunit.created / status_changed 唤醒过滤（观察段实现） */
  onWorkUnitClaimable(payload: unknown): void;
  /** 频道系统消息出口（结果记录段实现；claim/step 段共用） */
  postToDiscussionSpace(workUnitId: string, content: string, milestoneWu?: WorkUnitData, extraMeta?: MessageMeta): Promise<void>;

  // ── 租约/fencing seam（#178/#63，委托 wuLease；保注释语义的门面包装） ──
  /** #178（#63 决议 1/2）：为持有中的 WU 确保租约心跳在跑（令牌一致幂等跳过） */
  ensureLease(wu: WorkUnitData): void;
  /** 停止租约心跳（幂等）。#635：常规路径只在 runLoop 主循环退出点调用 */
  stopLease(): void;
  /** #178（#63 决议 2）：fencing 校验——比对 claimedAt 代际令牌 */
  stillHoldsLease(wuId: string): Promise<boolean>;
  /** #178（#63 决议 2）：易主善后——停心跳、杀自身 CLI 进程组、静默退出该 WU */
  handleLeaseLost(wuId: string, reason: 'lost' | 'missing'): Promise<void>;
  /** #178（#63 决议 2）：状态迁移前 fencing——易主即善后并返回 false */
  transitionIfHeld(wuId: string, status: string): Promise<boolean>;
  /** #178（#63 决议 1）：WU 离开 active 或已易主 → 停租约心跳（recordResult 后调用） */
  releaseLeaseIfForfeited(wuId: string): Promise<void>;
}
