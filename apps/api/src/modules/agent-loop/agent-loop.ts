// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// 工单 28（2026-08）拆分：类型契约 → agent-loop.types.js；输出解析/prompt 模板 →
// agent-loop-parsers.js；token/tool:call 事件落盘 → agent-loop-events.js；B2/F4 守卫 →
// agent-loop-guards.js。知识搜索分析块（knowledge-search-analysis）零生产调用方，工单 43 已删。
// 工单 05（2026-08）：prompt/上下文组装（含 buildSkill/Persona/RosterSection）→ prompt-composer.js；
// DELEGATE 分支（建子单 + collab 元数据 + 降级文案）→ delegate-branch.js。
// #541（2026-09）：agentStep 入口四段前置守卫（B2 测试 WU / C3 日预算 / #162 WU 预算 /
// #471 plan 额度）→ step-guards.js（对称出口侧 completion-gates 的 Ctx/Deps/Outcome 模式）。
// #543（2026-09）：agentStep 中段两段孪生重试骨架（#94 续用丢失降级 / #96 上下文溢出）
// → step-retry-policy.js（同 Ctx/Deps/Outcome 模式，fake executor 直测占额/簿记回写）。
// #635（2026-09）：stop() 语义收窄为「置退出意图」——不停租约心跳、不清租约轨道；
// 心跳续租与 fencing 活到 runLoop 主循环退出，退出点统一停心跳收尾（在飞 step 全程租约保护）。
// #655（2026-09）：recordResult 簿记段（计数推导 / F5 挂起标记 / B4 blocked 原因 /
// #170 锁内合并 mutator）→ result-bookkeeping.js（纯函数零 deps，mutator 引用闭包
// guardUpdates 保真 F6-c 后置 mutate）。
// #668（2026-10）：类本体按职责切五段深模块（纯结构移动，不改运行时行为）——
// loop-lifecycle.js（start/stop/实例状态 SSE/心跳自裁）/ loop-observe.js（observe + 事件唤醒）/
// loop-claim.js（认领 + 决策 14 适任判断）/ loop-step.js（agentStep 步执行编排）/
// loop-record-result.js（recordResult 结果回写编排 + 频道消息出口）；
// 段间共享状态与跨段调用经 loop-host.js 的 AgentLoopHost 接口显式化；
// 执行目录解析三规则 → execution-cwd.js（deps 注入，纯函数可直测）。
// 本文件 = 门面：构造接线 + runLoop 主循环编排 + 全部对外/测试 seam 的薄委托；
// 导出面 = AgentLoop + StepResult（#544 拆除 re-export 门面，
// 测试 import 已迁真属主 agent-loop-parsers / agent-loop-events / agent-loop-guards）。
import { logger, type FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit/index.js';
import type { MessageMeta } from '../channels/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getStore } from '../../core/store.js';
import { LocalExecutor, type Executor } from './executor.js';
import { WuLeaseTracker } from './wu-lease.js';
import { resolveTarget, dynamicInterval, sleep } from './agent-loop-parsers.js';
import type { StepResult, Observations, Target, RuntimeInstanceRow } from './agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';
import { LoopLifecycle } from './loop-lifecycle.js';
import { LoopObserver } from './loop-observe.js';
import { LoopClaim } from './loop-claim.js';
import { StepRunner } from './loop-step.js';
import { ResultRecorder } from './loop-record-result.js';

// 类型契约已抽到 ./agent-loop.types.js（工单 28，行为不变）；
// StepResult re-export 保留——completion-gates 等生产消费方经本门面取类型（#544）
export type { StepResult } from './agent-loop.types.js';

export class AgentLoop implements AgentLoopHost {
  // ── 段间共享状态（#668：原 private 字段转为 AgentLoopHost seam——段模块经接口读写；
  //    模块内部面，不经 index.ts 出模块；__tests__ 经 as unknown as 触达同名字段） ──
  readonly role: AgentProfileData;
  readonly workUnitService: WorkUnitService;
  readonly fileStore: FileStore;
  instance: RuntimeInstanceRow | null = null;
  readonly acceptedTypes: string[] = [];
  alive = false;
  triggerId: string | null = null;
  loopPromise: Promise<void> | null = null;
  /** #634: stop() 的 terminated 落盘写句柄——waitForStop 连带等待，
   *  registry 重挂（provider 变更）须等旧实例 terminated 落盘后再挂新 loop */
  terminateWrite: Promise<unknown> | null = null;
  lastIdleHeartbeatAt = 0;
  /** #330：事件驱动唤醒——空闲 sleep 的中断器（idleSleep 挂起期间非 null） */
  wakeIdle: (() => void) | null = null;
  /** #330：channel.message_sent 订阅句柄（start 挂、stop 退） */
  messageSentHandler: ((payload: { message?: { authorType?: string; workUnitId?: string | null } }) => void) | null = null;
  /** #493：唤醒闩锁——事件到达时 loop 不在 idleSleep（执行中/步骤间）则置 true，
   *  下一次 idleSleep 入口消费并立即放行重跑 observe，唤醒不再丢失（原 fire-and-forget 丢此类唤醒） */
  pendingWake = false;
  /** #523（#515 决议 P0-2）：workunit.status_changed 订阅句柄（start 挂、stop 退） */
  workunitChangedHandler: ((payload: unknown) => void) | null = null;
  readonly executor: Executor;
  /** 2026-07 PMO-flow UX（§6-2）：最后一次已发布的 instance 状态（SSE 去重——状态不变不发） */
  lastPublishedStatus: string | null = null;
  /** #178（#63 决议 1/2，#209 smell 4 迁出）：当前持有 WU 的租约轨道 + fencing 三件套（./wu-lease.js） */
  readonly wuLease: WuLeaseTracker;
  /** #178（#63 决议 2）：当前步 executionId——易主时据此经 Executor 杀自身 CLI 进程组 */
  currentExecutionId: string | null = null;
  /** #179（#66 决议 3 loop 侧）：实例心跳写连败计数（成功即清零，连败 HEARTBEAT_FAIL_LIMIT 次自裁） */
  consecutiveHeartbeatFailures = 0;
  /** B5（channel-flow-audit-fix）：observe 回复检测的增量水位（channelId → messages.jsonl
   *  字节偏移）。进程内存簿记，重启清零 = 首轮全扫重建（重启间隙回复经 #493 >= 口径捞回）。 */
  readonly replyScanWatermarks = new Map<string, number>();

  // ── 段模块（#668）：构造期接线，门面方法全部委托 ──
  private readonly lifecycle: LoopLifecycle;
  private readonly observer: LoopObserver;
  private readonly claim: LoopClaim;
  private readonly stepRunner: StepRunner;
  private readonly recorder: ResultRecorder;

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? getStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    // 决策 9: acceptedTypes 取 profile 显式字段（description 关键词解析已退役）
    this.acceptedTypes = role.acceptedTypes ?? [];
    // §9.6: 执行面走 Executor 接口。远程节点方向已放弃（origin/master bdaf0dd3：生产无
    // nodeId profile、无 WS 客户端活路径），统一 LocalExecutor；profile.nodeId 字段已随之删除。
    this.executor = new LocalExecutor();
    // #209 smell 4：租约/fencing 三件套迁 ./wu-lease.js，AgentLoop 只注入依赖 + 委托
    this.wuLease = new WuLeaseTracker({
      fileStore: this.fileStore,
      getAssigneeId: () => this.instance?.id ?? null,
      getCurrentExecutionId: () => this.currentExecutionId ?? undefined,
      stopProcessGroup: async (executionId) => { await this.executor.stopProcessGroup?.(executionId); },
      transitionStatus: (wuId, status) => this.workUnitService.transitionStatus(wuId, status, { id: this.instance?.id ?? this.role.id, type: 'agent' }),
    });
    // #668：五段模块接线（构造只挂引用，全部调用发生在运行期，无构造次序敏感）
    this.lifecycle = new LoopLifecycle(this);
    this.observer = new LoopObserver(this);
    this.claim = new LoopClaim(this);
    this.stepRunner = new StepRunner(this);
    this.recorder = new ResultRecorder(this);
  }

  // ── 公共 API（registry/bootstrap 消费）：委托生命周期段 ──

  /** Start the agent loop: create instance, register EVENT trigger, enter observe-decide-act cycle.
   *  Returns true when the loop started; false on startup-fatal failure (recorded for UI/monitoring, F2). */
  start(): Promise<boolean> {
    return this.lifecycle.start();
  }

  /** Stop the agent loop and clean up.
   *  #635：语义收窄为「置退出意图」——不停租约心跳、不清租约轨道；在飞 step 全程处于
   *  租约保护之下（续租不中断、易主 fencing 可达 handleLost），停心跳收尾在 runLoop 退出点 */
  stop(): void {
    this.lifecycle.stop();
  }

  /** Wait for the runLoop promise to fully settle (for test cleanup).
   *  #634: 连带等 stop() 的 terminated 落盘写——重挂方据此确认旧实例完全退出 */
  waitForStop(): Promise<void> {
    return this.lifecycle.waitForStop();
  }

  /** Main observe→resolveTarget→agentStep→recordResult loop（编排本体留门面） */
  async runLoop(): Promise<void> {
    while (this.alive) {
      try {
        const observations = await this.observe();
        const target = resolveTarget(observations);

        if (!target) {
          // No work available → back to idle (fix: status stays correct after task completion)
          await this.updateIdleState();
          await this.idleSleep(15_000);
          continue;
        }

        // Claim if unassigned
        if (target.workUnit.status === 'unassigned') {
          // 决策 14 认领前适任判断（「做不了的不抢」）：一次性 LLM 判 no → 落档
          // metadata.unfitRoles 后本轮放弃；下一轮 observe 经第 7 道过滤自动看下一候选，
          // 全部候选不适任则静默等待。成本与认领次数成正比，不进 observe 轮询
          if (!(await this.ensureClaimFit(target.workUnit))) {
            continue;
          }
          const claimed = await this.claimAndAnnounce(target.workUnit);
          if (!claimed) {
            await sleep(1_000);
            continue;
          }
          const afterClaim = await this.workUnitService.getById(target.workUnit.id);
          if (afterClaim) target.workUnit = afterClaim;
        }

        // Update heartbeat + status=active (fix: monitoring.active was always 0)
        if (this.instance) {
          // #179（#66 决议 3 loop 侧）：心跳写连败 ≈3 次自裁；自裁后中止本次迭代不开新 step
          const stillAlive = await this.lifecycle.updateStateWithHeartbeatWatch({
            lastHeartbeat: new Date().toISOString(),
            currentWorkUnitId: target.workUnit.id,
            status: 'active',
          });
          if (!stillAlive) continue;
          // 2026-07 PMO-flow UX（§6-2）：忙闲变化 SSE（仅状态实际变化时发一次）
          void this.publishInstanceStatus('active', target.workUnit.id);
        }

        // #178（#63 决议 1）：持有中 WU 的 30s 租约心跳（claim 与 myActive 续跑统一入口）
        this.ensureLease(target.workUnit);

        const result = await this.agentStep(target);
        await this.recordResult(target, result);
        // #178（#63 决议 1）：WU 离开 active（complete→in_review/done、need_input→blocked）
        // 或已易主 → 停租约心跳（blocked 不进超时扫描；复活回 active 时 ensureLease 重开）
        await this.releaseLeaseIfForfeited(target.workUnit.id);
        // #523（#515 决议 P0-5）：步间 sleep 复用同一 wakeIdle 可中断原语——
        // 认领事件到达即提前结束本睡、立即回环 observe，不引入新机制
        await this.idleSleep(dynamicInterval(result));
      } catch (err) {
        const message = getErrorMessage(err);
        logger.error(`[AgentLoop] Loop iteration error: ${message}`);
        await sleep(15_000);
      }
    }
    // #635：租约收尾统一到主循环退出点——stop() 只置退出意图，在飞 step 跑完前
    // 心跳续租与 fencing 保持运行（窗口内易主检出 → handleLost 杀进程组链路可达）；
    // 退出后心跳停止，WU 租约按既有 5min TTL 到期回收。迭代体有内层 catch-all，
    // 正常退出（alive=false）必达此点；紧急自裁（心跳连败）路径已先行停跳，此处幂等
    this.stopLease();
  }

  // ── 租约/fencing seam（#178/#63，委托 wuLease；loop-host 接口面，含原包装注释语义） ──

  /** #178（#63 决议 1/2）：为持有中的 WU 确保租约心跳在跑。
   *  新认领与 myActive 续跑（含 blocked 复活回 active）统一经此进入；令牌（wuId+claimedAt）
   *  与在跑轨道一致时幂等跳过，令牌换代（如本实例重新认领）先停旧轨再开新轨。 */
  ensureLease(wu: WorkUnitData): void {
    this.wuLease.ensure(wu);
  }

  /** 停止租约心跳（幂等）。#635：常规路径只在 runLoop 主循环退出点调用；
   *  紧急自裁（心跳连败）与易主善后（handleLost）各自即时调用 */
  stopLease(): void {
    this.wuLease.stop();
  }

  /** #178（#63 决议 2）：fencing 校验 —— 步结果回写前 / 状态迁移前比对 claimedAt 代际令牌
   *  （「每次心跳前」校验由 refreshWorkUnitLease 快速路完成，落盘时锁内复核）。无租约轨道
   *  （未 start 的测试直调等）不拦，保持既有行为。 */
  stillHoldsLease(wuId: string): Promise<boolean> {
    return this.wuLease.stillHolds(wuId);
  }

  /** #178（#63 决议 2）：易主善后 —— 停止心跳、杀自身 CLI 进程组（best-effort）、
   *  静默退出该 WU（不发频道消息、不写回：fencing 语义就是「旧 holder 一字不再写」）。 */
  handleLeaseLost(wuId: string, reason: 'lost' | 'missing'): Promise<void> {
    return this.wuLease.handleLost(wuId, reason);
  }

  /** #178（#63 决议 2）：状态迁移前 fencing —— 易主即善后并返回 false（调用方立即静默退出），
   *  持有有效才执行真实迁移。 */
  transitionIfHeld(wuId: string, status: string): Promise<boolean> {
    return this.wuLease.transitionIfHeld(wuId, status);
  }

  /** #178（#63 决议 1）：WU 离开 active 或已易主 → 停租约心跳（recordResult 后调用） */
  releaseLeaseIfForfeited(wuId: string): Promise<void> {
    return this.wuLease.releaseIfForfeited(wuId);
  }

  // ── 跨段方法（loop-host 接口面）+ 测试 seam（__tests__ 经 as unknown as 触达）：
  //    全部薄委托到段模块，行为本体在段内 ──

  onChannelMessageSent(payload: { message?: { authorType?: string; workUnitId?: string | null } }): void {
    this.observer.onChannelMessageSent(payload);
  }

  onWorkUnitClaimable(payload: unknown): void {
    this.observer.onWorkUnitClaimable(payload);
  }

  postToDiscussionSpace(workUnitId: string, content: string, milestoneWu?: WorkUnitData, extraMeta?: MessageMeta): Promise<void> {
    return this.recorder.postToDiscussionSpace(workUnitId, content, milestoneWu, extraMeta);
  }

  observe(): Promise<Observations> {
    return this.observer.observe();
  }

  idleSleep(ms: number): Promise<void> {
    return this.observer.idleSleep(ms);
  }

  claimAndAnnounce(workUnit: WorkUnitData): Promise<boolean> {
    return this.claim.claimAndAnnounce(workUnit);
  }

  ensureClaimFit(wu: WorkUnitData): Promise<boolean> {
    return this.claim.ensureClaimFit(wu);
  }

  updateIdleState(): Promise<void> {
    return this.lifecycle.updateIdleState();
  }

  publishInstanceStatus(status: string, currentWorkUnitId: string | null): Promise<void> {
    return this.lifecycle.publishInstanceStatus(status, currentWorkUnitId);
  }

  recordStartupFailure(message: string): Promise<void> {
    return this.lifecycle.recordStartupFailure(message);
  }

  agentStep(target: Target): Promise<StepResult> {
    return this.stepRunner.agentStep(target);
  }

  recordResult(target: Target, result: StepResult): Promise<void> {
    return this.recorder.recordResult(target, result);
  }
}
