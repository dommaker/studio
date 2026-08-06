// AgentLoop — observe→resolveTarget→agentStep→recordResult decision loop (AS-025)
// Orchestration layer: zero LLM calls. Agent = external compute (Claude Code/OpenCode/Codex).
// Knowledge search analysis preserved as module-level exports.
import { execSync } from 'child_process';
import { eventBus, logger, parseStreamEvents, extractToolCalls, FileStore, parseChannels, estimateTokens, parseSessionMetrics, withAttestation, type RuntimeStateData, type ChannelMessageData } from '@dommaker/studio-shared';
import { resolveProviderDefinition, buildHealthProbeCommand } from '@dommaker/studio-shared/node';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import { ensureWuWorktree, ensureBranchExists, getDefaultBranch } from '@dommaker/studio-agent';
import { LocalExecutor, type Executor } from './executor.js';
import { RemoteExecutor, RemoteNodeUnreachableError } from './remote-executor.js';
import { WorkUnitService, ANALYSIS_TASKS_MAX, snapshotToData, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import { checkDelegation, effectiveParentCollab, resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT, type CollabMeta } from '../workunit/delegation-gate.js';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { getTriggerScheduler } from '../triggers/trigger-registry.js';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { loadManifest } from '../skills/manifest-loader.js';
import { selectSkillsWithDomain, parseSkillHintsFromScope } from '../skills/skill-selector.js';
import { eventStore } from '../../core/event-store.js';
import { postWuSystemMessage } from '../workunit/wu-messenger.js';
import { parseWuMetadata, mergedWuView } from '../workunit/wu-metadata.js';
import { resolveWorkspaceRoot } from '../workspaces/workspace-store.js';
import { resolvePmoBranchForWU } from '../requirements/pmo-branch-resolver.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { resolveStudioEventsFile } from '../../utils/studio-events.js';
import {
  tokenBudgetGuardEnabled, resolveDailyTokenBudget, getDailyTokenUsage,
  noteTokensWritten, notifyBudgetTripped,
} from './daily-token-budget.js';
import { emitExecutionStepEvent, emitExecutionStreamLine, emitExecutionStreamStepStart } from './execution-step-events.js';
import { CODE_WORKTREE_TYPES, runWuVerification } from './wu-verification.js';
import { runCompletionGuards } from './completion-gates.js';
import type { ParsedReviewReport } from './review-contract.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

/** M2: workunit:tokens 事件写入目标（与 knowledge consumption/outcome 事件同一事件流）。
 *  STUDIO_EVENTS_JSONL 环境变量可覆盖（测试隔离用）；缺省走 resolveStudioLogFile ——
 *  测试环境（VITEST/NODE_ENV=test）自动改写 tmpdir，防止测试污染生产事件流
 *  （2026-08-03 token-burn issue：生产 studio-events.jsonl 曾混入大量 wu-cumulative-tokens 测试行）。
 *  调用时惰性解析：测试在 import 本模块后仍可改 env 生效。 */
function studioEventsJsonlPath(): string {
  return process.env.STUDIO_EVENTS_JSONL || resolveStudioLogFile('studio-events.jsonl');
}

/** B3b-i: 代码类 WU 判定与验证实现已抽到 ./wu-verification.js（F6-c，供强制收口与 /verify 端点复用） */
/** 步骤数上限：超限强制 in_review 交人工。review WU 单独放宽——
 *  评审职责是读不是写，无提交守卫豁免后正常 ≤5 步收口；阈值仅是防死循环的安全阀 */
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;

/** B5（2026-08-03 token-burn issue P1-1）：每 WU 独立会话数上限。
 *  会话反复重建（stuck 重开 / token 截断重开）意味着整段 transcript 全文重放重新烧一遍；
 *  超限说明自动执行已失控，转 need_input 等人工评估（人工回复经 resumeWaitingWorkUnit 重置预算）。 */
const MAX_SESSIONS_PER_WU = 2;

/** B2（2026-08-03 token-burn issue P0-1c）：测试特征 scope 判定 ——
 *  scope 中出现独立单词 test/tests 即视为测试 WU（命中历史污染源 'tree-tokens test' / 'test' 等）。
 *  仅作 daemon 兜底：正常隔离由 B1（测试独立数据根）保证，这里是防漏网的第二道。 */
const TEST_SCOPE_PATTERN = /(?:^|[\s\-_/:])tests?(?:[\s\-_/:]|$)/i;

/** B2 守卫开关：默认仅生产/开发进程启用；测试环境（NODE_ENV=test / VITEST）默认关闭
 *  （仓库自身单测用 scope 'test' 驱动 loop，守卫会误伤）；可用 STUDIO_TEST_WU_GUARD=on/off 显式覆盖。 */
export function testWuGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STUDIO_TEST_WU_GUARD === 'on') return true;
  if (env.STUDIO_TEST_WU_GUARD === 'off') return false;
  return env.NODE_ENV !== 'test' && !env.VITEST;
}

/** B2 测试特征 WU 判定：metadata 显式标记（test/testWorkUnit）或 scope 命中测试名单模式 */
export function isTestLikeWorkUnit(wu: { scope: string }, metadata: WorkUnitMetadata): boolean {
  if (metadata.test === true || metadata.testWorkUnit === true) return true;
  return TEST_SCOPE_PATTERN.test(wu.scope ?? '');
}
const metricsFileStore = new FileStore();

/** F6-fix: 空闲分支心跳节流间隔 — agent-timeout-scan 阈值为 5min，45s 一次足够保活 */
const IDLE_HEARTBEAT_INTERVAL_MS = 45_000;
/** 单活实例守卫：心跳/启动时间新鲜度阈值（idle 心跳 45s 一跳，留近 3 跳余量） */
const LIVE_HOLDER_THRESHOLD_MS = 120_000;

/** F4（reviewer 解锚，决策 5）：安全解析 WU metadata.excludeAssignee ——
 *  评审 WU 禁止认领的 profile id；缺失/损坏/非字符串一律 null（不排除） */
function parseExcludeAssignee(metadata: unknown): string | null {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const v = (m as { excludeAssignee?: unknown } | null)?.excludeAssignee;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * §10 P0: 注入总预算（skill 段 + 知识段共用的 2K 红线）。
 * 必须与 knowledge-service 的 INJECT_TOKEN_BUDGET 保持一致——
 * 不从 knowledge-service import：现有测试以 vi.mock 工厂替换整个 knowledge-service
 * 模块（只暴露 knowledgeService），新增命名导入会在 mock 模块上访问不到而抛错。
 */
const INJECT_TOKEN_BUDGET = 2_000;

/** Result of analyzing agent log for knowledge search behavior */
export interface KnowledgeSearchAnalysis {
  searched: boolean;
  searchCalls: Array<{ tool: string; detail?: string }>;
}

/** Agent output action after parsing */
export interface StepResult {
  // 'failed': CLI 执行失败（runner 返回 success:false）的显式分支——记 consecutiveStuck、
  // 不发频道消息，达到 3 次走既有 blocked 路径（W-3 接线，见 agentStep）
  // 'skipped': B2 测试特征 WU 守卫 —— agentStep 已自行关闭 WU，recordResult 直接跳过
  action: 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed' | 'skipped';
  summary: string;
  /** A2A §4.1: DELEGATE 协议解析结果（action='delegate' 时存在） */
  delegate?: { targetName: string; scope: string };
  /** §4.2 发言层新鲜度检查：step 开始时捕获的频道版本（agentStep 写入，recordResult 比对） */
  channelVersion?: { lineCount: number; lastMessageId: string | null };
  /** Metadata fields to merge into WorkUnit.metadata (set by agentStep, written atomically by recordResult) */
  metadataUpdates?: Partial<WorkUnitMetadata>;
}

/** Observation collected from DB */
interface Observations {
  myActive: WorkUnitData[];
  unassigned: WorkUnitData[];
  newReplies: ChannelMessageData[];
}

/** Resolved target for agentStep */
interface Target {
  workUnit: WorkUnitData;
  newReplies?: ChannelMessageData[];
}

interface RuntimeInstanceRow {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: string;
  terminatedAt: string | null;
  metadata: string | null;
  lastHeartbeat: string | null;
}

export class AgentLoop {
  private role: AgentProfileData;
  private workUnitService: WorkUnitService;
  private fileStore: FileStore;
  private instance: RuntimeInstanceRow | null = null;
  private acceptedTypes: string[] = [];
  private alive = false;
  private myChannels: string[] = [];
  private triggerId: string | null = null;
  private loopPromise: Promise<void> | null = null;
  private lastIdleHeartbeatAt = 0;
  private executor: Executor;
  /** 2026-07 PMO-flow UX（§6-2）：最后一次已发布的 instance 状态（SSE 去重——状态不变不发） */
  private lastPublishedStatus: string | null = null;

  constructor(role: AgentProfileData, fileStore?: FileStore) {
    this.role = role;
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    // 决策 9: acceptedTypes 取 profile 显式字段（description 关键词解析已退役）
    this.acceptedTypes = role.acceptedTypes ?? [];
    // W-4 fix + F3: parse channels from role.channels JSON（容错历史双重编码值）
    this.myChannels = parseChannels(role.channels);
    // §9.6: 执行面走 Executor 接口。profile.nodeId: undefined/'local' → LocalExecutor
    // 其他 → RemoteExecutor(nodeId)。P1 WS 通道留桩，RemoteExecutor 暂抛不可达错误。
    if (role.nodeId && role.nodeId !== 'local') {
      this.executor = new RemoteExecutor(role.nodeId);
      logger.info('[AgentLoop] RemoteExecutor selected', { role: role.name, nodeId: role.nodeId });
    } else {
      this.executor = new LocalExecutor();
    }
  }

  /** Start the agent loop: create instance, register EVENT trigger, enter observe-decide-act cycle.
   *  Returns true when the loop started; false on startup-fatal failure (recorded for UI/monitoring, F2). */
  async start(): Promise<boolean> {
    try {
      // AC-4.5 + F4: Health probe — verify the profile's provider CLI is available
      const providerId = this.role.provider || 'claude';
      const probeCmd = buildHealthProbeCommand(providerId);
      try {
        execSync(probeCmd, { timeout: 5000 });
      } catch {
        const message = `${resolveProviderDefinition(providerId).displayName} CLI not available (health probe \`${probeCmd}\` failed)`;
        logger.error(`[AgentLoop] ${message} — agent ${this.role.name} unavailable`);
        await this.recordStartupFailure(message);
        return false;
      }

      const allStates = await this.fileStore.listStates();

      // 2026-07-30 走查修复：清理该 roleId 的 terminated 历史实例（防累积）
      // 每次 API 重启都创建新 idle 实例，旧 terminated state.json 不清理会无限累积
      // （~/.studio/data/agents/<id>/state.json 残留，监控/频道侧栏显示历史噪音）
      for (const s of allStates.filter(s => s.roleId === this.role.id && s.status === 'terminated')) {
        await this.fileStore.deleteState(s.id).catch(() => {});
      }

      // F2: recovery — a successful probe clears previous error states for this role
      for (const s of allStates.filter(s => s.roleId === this.role.id && s.status === 'error')) {
        await this.fileStore.updateState(s.id, {
          status: 'terminated',
          terminatedAt: new Date().toISOString(),
          lastError: null,
          lastErrorAt: null,
        }).catch(() => {});
      }

      // AC-4.6: Detect and clean up stale previous instances for this role
      const stalePrev = allStates.find(s => s.roleId === this.role.id && s.status !== 'error' && s.status !== 'terminated' && s.pid && !isProcessAlive(s.pid));
      if (stalePrev) {
        logger.info(`[AgentLoop] Cleaning up stale instance ${stalePrev.id} (PID ${stalePrev.pid})`);
        await this.fileStore.updateState(stalePrev.id, { status: 'terminated' }).catch(() => {});
      }

      // 同角色单活实例守卫（2026-07-30 走查修复）：另一进程持有的活实例存在时 standby。
      // 判活 = 异 pid 进程存活 且 心跳新鲜（lastHeartbeat/startedAt 在阈值内）。
      // 防 dev/prod 双实例共享同一 ~/.studio 时同 profile 被重复挂载（认领竞争、频道重复
      // 回复、会话续用错位命中）。持有者死亡/心跳停摆后，下次挂载（重启或 profile 生命周期
      // 事件）自动接管。stale 清理只管死 pid，管不了两个活进程——本守卫补这一层。
      const liveHolder = allStates.find(s => {
        if (s.roleId !== this.role.id) return false;
        if (s.status === 'error' || s.status === 'terminated') return false;
        if (!s.pid || s.pid === process.pid || !isProcessAlive(s.pid)) return false;
        const beat = s.lastHeartbeat ?? s.startedAt;
        return !!beat && (Date.now() - new Date(beat).getTime()) < LIVE_HOLDER_THRESHOLD_MS;
      });
      if (liveHolder) {
        const message = `role 已有活实例 ${liveHolder.id}（pid ${liveHolder.pid}，心跳新鲜）持有，本实例 standby —— 持有者退出后重启本实例即可接管`;
        logger.warn(`[AgentLoop] ${this.role.name}: ${message}`);
        await this.recordStartupFailure(message);
        return false;
      }

      const now = new Date().toISOString();
      const instanceId = randomUUID();
      const state: RuntimeStateData = {
        id: instanceId,
        roleId: this.role.id,
        sessionId: null,
        status: 'idle',
        currentWorkUnitId: null,
        startedAt: now,
        terminatedAt: null,
        lastHeartbeat: null,
        metadata: null,
        pid: process.pid,
      };
      await this.fileStore.createState(instanceId, state);
      this.instance = state;

      this.alive = true;
      logger.info(`[AgentLoop] Started for role ${this.role.name} (instance=${this.instance.id})`);

      // AC-3: Register EVENT trigger for workunit.created
      const scheduler = getTriggerScheduler();
      this.triggerId = `agent-loop-${this.role.id}-workunit-created`;
      const handlerTarget = `agent-loop-${this.role.id}-observe`;

      scheduler.registerExecuteHandler(handlerTarget, async () => {
        if (this.alive) {
          this.observe().catch(err =>
            logger.warn(`[AgentLoop] EVENT-triggered observe failed: ${err.message}`)
          );
        }
      });

      scheduler.registerTrigger({
        id: this.triggerId,
        name: `Agent ${this.role.name} observe on workunit.created`,
        condition: { type: 'EVENT', event: 'workunit.created' },
        action: { type: 'EXECUTE', target: handlerTarget },
        enabled: true,
        scope: 'agent',
      });

      // Main loop (non-blocking — fire and forget like original)
      this.loopPromise = this.runLoop().catch(err =>
        logger.error(`[AgentLoop] Loop failed for ${this.role.name}: ${err.message}`)
      );
      return true;
    } catch (err) {
      // F2: any other startup-fatal failure is also surfaced
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] Startup failed for ${this.role.name}: ${message}`);
      await this.recordStartupFailure(message).catch(() => {});
      return false;
    }
  }

  /** F2: Record a startup-fatal failure to runtime state (state.json) + notify via eventBus and SSE */
  private async recordStartupFailure(message: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      // Reuse this role's existing error state if any (avoid one record per retry)
      const allStates = await this.fileStore.listStates();
      const existing = allStates.find(s => s.roleId === this.role.id && s.status === 'error');
      if (existing) {
        await this.fileStore.updateState(existing.id, { lastError: message, lastErrorAt: now });
      } else {
        const instanceId = randomUUID();
        const state: RuntimeStateData = {
          id: instanceId,
          roleId: this.role.id,
          sessionId: null,
          status: 'error',
          currentWorkUnitId: null,
          startedAt: now,
          terminatedAt: null,
          lastHeartbeat: null,
          metadata: null,
          pid: process.pid,
          lastError: message,
          lastErrorAt: now,
        };
        await this.fileStore.createState(instanceId, state);
      }
    } catch (err) {
      logger.warn(`[AgentLoop] Failed to record startup failure state: ${err instanceof Error ? err.message : String(err)}`);
    }

    const payload = { profileId: this.role.id, name: this.role.name, provider: this.role.provider ?? 'claude', error: message };
    eventBus.publish('agent.health.failed', payload);
    // SSE 'events' topic (same shape as channel-message.service.ts publishSSE)
    eventStore.publish('events', JSON.stringify({
      event_type: 'agent.health.failed',
      event_id: randomUUID(),
      timestamp: now,
      data: payload,
    })).catch(() => {}); // best-effort
  }

  /** Main observe→resolveTarget→agentStep→recordResult loop */
  private async runLoop(): Promise<void> {
    while (this.alive) {
      try {
        const observations = await this.observe();
        const target = resolveTarget(observations);

        if (!target) {
          // No work available → back to idle (fix: status stays correct after task completion)
          await this.updateIdleState();
          await sleep(15_000);
          continue;
        }

        // Claim if unassigned
        if (target.workUnit.status === 'unassigned') {
          try {
            await this.workUnitService.claim(target.workUnit.id, this.instance!.id);
            const afterClaim = await this.workUnitService.getById(target.workUnit.id);
            if (afterClaim) target.workUnit = afterClaim;
          } catch {
            await sleep(1_000);
            continue;
          }
        }

        // Update heartbeat + status=active (fix: monitoring.active was always 0)
        if (this.instance) {
          await this.fileStore.updateState(this.instance.id, {
            lastHeartbeat: new Date().toISOString(),
            currentWorkUnitId: target.workUnit.id,
            status: 'active',
          }).catch(() => {});
          // 2026-07 PMO-flow UX（§6-2）：忙闲变化 SSE（仅状态实际变化时发一次）
          this.publishInstanceStatus('active', target.workUnit.id);
        }

        const result = await this.agentStep(target);
        await this.recordResult(target, result);
        await sleep(dynamicInterval(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLoop] Loop iteration error: ${message}`);
        await sleep(15_000);
      }
    }
  }

  /**
   * Idle branch state update. F6-fix: 空闲也要刷新 lastHeartbeat（按
   * IDLE_HEARTBEAT_INTERVAL_MS 节流），否则 agent-timeout-scan 会把
   * 空闲 >5min 的实例标记 terminated（内存 loop 仍在跑，监控却显示已终止）。
   */
  private async updateIdleState(): Promise<void> {
    if (!this.instance) return;
    const update: { status: string; currentWorkUnitId: null; lastHeartbeat?: string } = {
      status: 'idle',
      currentWorkUnitId: null,
    };
    const nowMs = Date.now();
    if (nowMs - this.lastIdleHeartbeatAt >= IDLE_HEARTBEAT_INTERVAL_MS) {
      update.lastHeartbeat = new Date(nowMs).toISOString();
      this.lastIdleHeartbeatAt = nowMs;
    }
    await this.fileStore.updateState(this.instance.id, update).catch(() => {});
    // 2026-07 PMO-flow UX（§6-2）：进入 idle 发一次 SSE；45s 节流心跳重入不重复发
    this.publishInstanceStatus('idle', null);
  }

  /**
   * 2026-07 PMO-flow UX（§6-2）：instance 忙闲变化发 SSE（agent.instance.status_changed）。
   * 形状与 recordStartupFailure 的 agent.health.failed 一致（events topic 信封；
   * sse.routes 无 agent.* 显式映射 → 落 all topic，前端订阅 all 即收，无需改路由）。
   * 仅在 status 相对上次发布实际变化时发（lastPublishedStatus 去重）——
   * updateIdleState 的 45s 节流分支反复进入 idle 不刷屏。best-effort，绝不阻断主循环。
   */
  private publishInstanceStatus(status: string, currentWorkUnitId: string | null): void {
    if (!this.instance || this.lastPublishedStatus === status) return;
    this.lastPublishedStatus = status;
    eventStore.publish('events', JSON.stringify({
      event_type: 'agent.instance.status_changed',
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        profileId: this.role.id,
        instanceId: this.instance.id,
        name: this.role.name,
        status,
        currentWorkUnitId,
      },
    })).catch(() => {}); // best-effort
  }

  /** Stop the agent loop and clean up */
  stop(): void {
    this.alive = false;
    if (this.triggerId) {
      getTriggerScheduler().unregisterTrigger(this.triggerId);
    }
    if (this.instance) {
      this.fileStore.updateState(this.instance.id, {
        status: 'terminated',
        terminatedAt: new Date().toISOString(),
      }).catch(err => logger.error(`[AgentLoop] Failed to terminate instance: ${err.message}`));
    }
  }

  /** Wait for the runLoop promise to fully settle (for test cleanup) */
  async waitForStop(): Promise<void> {
    if (this.loopPromise) {
      try { await this.loopPromise; } catch { /* loop errors already logged */ }
    }
  }

  /**
   * §9.5: 加载全部频道的 members（channelId → member profile ids）。
   * 每次 observe 调用一次；读取失败按空表处理（全量走 profile.channels 回退，不致停摆）。
   */
  private async loadChannelMembers(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    try {
      const channels = await this.fileStore.listChannels();
      for (const ch of channels) {
        map.set(ch.id, parseChannels(ch.members));
      }
    } catch { /* non-blocking — 回退到 profile.channels 口径 */ }
    return map;
  }

  /** Observe: collect state from DB (zero token) */
  private async observe(): Promise<Observations> {
    // 工单 27：index.json 每轮只读一次——myActive 由同一批快照本地派生，
    // 过滤/排序/分页口径与 workUnitService.list({assigneeId}) 完全一致
    // （含先按 createdAt desc 取前 20 条、再按状态过滤的顺序）。
    const allSnapshots = await this.fileStore.getIndex();
    const myAssigneeId = this.instance?.id;
    const mine = myAssigneeId
      ? allSnapshots.filter(s => s.assigneeId === myAssigneeId)
      : [...allSnapshots];
    const myActive = mine
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20)
      .map(snapshotToData)
      .filter(wu => wu.status === 'active' || wu.status === 'blocked');
    // §9.5: channel.members 为成员关系唯一事实源 — observe 每轮加载一次频道配置
    // （FileStore 规模小，成本可忽略）。
    const channelMembers = await this.loadChannelMembers();
    const unassigned = allSnapshots.filter(s => {
      if (s.status !== 'unassigned') return false;
      // Assignee-aware claiming（@mention 语义，docs/vision-2026.md §3）：
      // 显式指派给某个 profile 的 WorkUnit 只能被该 profile 的 loop 认领；
      // 未指派的保持频道作用域（§9.5: 频道 members 含本 profile）。
      // 决策 10：认领纯显式，不再有 acceptedTypes 类型过滤（推断只用于 skill 排序，不否决路由）。
      if (s.assigneeId) {
        if (s.assigneeId !== this.role.id) return false;
      } else if (s.channelId) {
        const members = channelMembers.get(s.channelId);
        if (members && members.length > 0) {
          // members 非空 → 唯一事实源：仅频道成员可见
          if (!members.includes(this.role.id)) return false;
        } else if (this.myChannels.length > 0 && !this.myChannels.includes(s.channelId)) {
          // 过渡期回退：频道无 members（历史数据未回填）时沿用旧 profile.channels 口径
          return false;
        }
      }
      // F4（reviewer 解锚，决策 5）：评审 WU 排除实现者 —— metadata.excludeAssignee
      // 命中的 profile 不可见（自评兜底场景 dispatcher 不设该字段，此处自然放行）
      if (parseExcludeAssignee(s.metadata) === this.role.id) return false;
      return true;
    }).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, 5)
      .map(s => ({
        id: s.id, parentId: s.parentId, type: s.type, scope: s.scope,
        assigneeId: s.assigneeId, status: s.status, failureType: s.failureType,
        retryCount: s.retryCount, timeoutAt: s.timeoutAt ? new Date(s.timeoutAt) : null,
        channelId: s.channelId, projectPath: s.projectPath, workspaceId: s.workspaceId ?? null, metadata: s.metadata,
        createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
        claimedAt: s.claimedAt ? new Date(s.claimedAt) : null,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
      }));

    const activeWuIds = myActive.map(wu => wu.id);
    const allReplies = activeWuIds.length > 0
      ? (await this.fileStore.queryAllMessages({
          workUnitIds: activeWuIds,
          authorType: 'human',
        })).filter(msg => {
          const wu = myActive.find(w => w.id === msg.workUnitId);
          return wu && new Date(msg.createdAt).getTime() > wu.updatedAt.getTime();
        })
      : [];

    return { myActive, unassigned, newReplies: allReplies };
  }

  /** Execute one step via Agent process (Agent's token) */
  private async agentStep(target: Target): Promise<StepResult> {
    const wu = target.workUnit;
    const metadata = parseWuMetadata(wu.metadata);

    // B2 守卫（2026-08-03 token-burn issue P0-1c）：测试特征 WU 不起会话、直接关闭。
    // 历史事故：路由测试经共享数据根把测试 WU 写进生产 FileStore，daemon 当真任务逐个
    // 起 Claude 会话执行（16 个会话 420 万 token）。关闭留痕 testWorkUnitGuard + blockReason。
    if (testWuGuardEnabled() && isTestLikeWorkUnit(wu, metadata)) {
      logger.warn('[AgentLoop] Test-like WorkUnit guarded — closing without execution', {
        workUnitId: wu.id, scope: wu.scope,
      });
      await this.workUnitService.update(wu.id, {
        metadata: { ...metadata, testWorkUnitGuard: true, blockReason: 'test-wu-guard: 测试特征任务，守卫关闭' },
      }).catch(err => logger.warn('[AgentLoop] test-wu guard metadata write failed', { workUnitId: wu.id, error: String(err) }));
      if (wu.status !== 'closed') {
        await this.workUnitService.transitionStatus(wu.id, 'closed')
          .catch(err => logger.warn('[AgentLoop] test-wu guard close failed', { workUnitId: wu.id, error: String(err) }));
      }
      await this.postToDiscussionSpace(wu.id, '检测到测试特征任务，已跳过执行并关闭（防止测试数据空烧 token）')
        .catch(() => {});
      return { action: 'skipped', summary: '' };
    }

    // C3 守卫（2026-08-03 token-burn issue P2-2，决策记录 #4）：每日 token 预算熔断。
    // 当日 billed 口径消耗 ≥ 预算（默认 2M/日，STUDIO_DAILY_TOKEN_BUDGET 覆盖，<=0 关闭）→
    // 不起会话，WU 经 need_input 挂起（recordResult 落 waitingForInput + blockReason），
    // 等次日本地零点预算复位或人工处置；全局当日只告警一次（studio:budget-tripped 事件留痕）。
    // 用量走进程内计数器（daily-token-budget），仅首次/跨天全量扫一次事件文件，不拖慢热路径。
    if (tokenBudgetGuardEnabled()) {
      const dailyBudget = resolveDailyTokenBudget();
      if (dailyBudget > 0) {
        const eventsFile = studioEventsJsonlPath();
        const daily = await getDailyTokenUsage({ eventsFile });
        if (daily.usedTokens >= dailyBudget) {
          logger.warn('[AgentLoop] Daily token budget tripped — pausing automatic execution', {
            workUnitId: wu.id, usedTokens: daily.usedTokens, budget: dailyBudget,
          });
          if (!daily.notified) {
            await notifyBudgetTripped({ eventsFile, usedTokens: daily.usedTokens, budget: dailyBudget });
          }
          return {
            action: 'need_input' as const,
            summary: `每日 token 预算已熔断（当日已用 ${daily.usedTokens.toLocaleString()} / 上限 ${dailyBudget.toLocaleString()}，billed 口径含 cache_read）：已暂停自动执行、不再起会话。次日（本地零点）预算复位后回复任意内容继续，或直接关闭任务`,
          };
        }
      }
    }
    // P0 修复 6: traceId 贯穿 — 频道消息 → WU metadata → 执行参数（extraEnv）与日志行
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // §4.2 发言层新鲜度检查：step 开始记录频道版本（recordResult 回帖前比对）。
    // 读取失败按 undefined 处理 —— 跳过检查直接发帖，绝不阻断执行。
    const channelVersion = wu.channelId
      ? await this.fileStore.getChannelVersion(wu.channelId).catch(() => undefined)
      : undefined;

    // F5: 恢复挂起时由 message-routing 写入的人类回复（优先级最高，注入后即消费）
    const pendingReplies = Array.isArray(metadata.pendingReplies)
      ? metadata.pendingReplies.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    // §10.5 提交守卫：上一轮 COMPLETE 被打回时 recordResult 写入的提示（注入后即消费）
    const commitGuardHint = typeof metadata.commitGuardHint === 'string' && metadata.commitGuardHint.length > 0
      ? metadata.commitGuardHint
      : null;

    // B3b-i 自动验证：上一轮 COMPLETE 因验证失败被打回时 recordResult 写入的提示（注入后即消费）
    const verifyFailHint = typeof metadata.verifyFailHint === 'string' && metadata.verifyFailHint.length > 0
      ? metadata.verifyFailHint
      : null;

    // §6-2 父 complete 守卫：上一轮 COMPLETE 因子任务未完结被打回时的提示（注入后即消费）
    const childGuardHint = typeof metadata.childGuardHint === 'string' && metadata.childGuardHint.length > 0
      ? metadata.childGuardHint
      : null;

    const basePrompt = pendingReplies.length > 0
      ? buildReplyPrompt(wu, pendingReplies)
      : target.newReplies?.length
        ? buildReplyPrompt(wu, target.newReplies.map(r => r.content))
        : buildContinuePrompt(wu);
    let prompt = basePrompt;
    if (commitGuardHint) prompt = `${prompt}\n\n## 提交提醒\n\n${commitGuardHint}`;
    if (verifyFailHint) prompt = `${prompt}\n\n## 验证失败\n\n${verifyFailHint}`;
    if (childGuardHint) prompt = `${prompt}\n\n## 子任务提醒\n\n${childGuardHint}`;

    // GAP-5: Knowledge injection — non-blocking
    // R1 反馈环: 接住 injectContext 返回的 injectedIds，贯穿到 recordOutcome /
    // extractFromExecution 的 consumedKnowledge（断点 A：此前注入 id 被丢弃，
    // outcome 永远上报 consumedKnowledge: []，飞轮无反馈数据）。
    // §10 P0 + 决策 7/13: 注入段共用 2K 红线，优先级 skills > persona > roster > knowledge——
    // skill 段（## 本次任务 Skills）step 时计算，先占预算；persona 段（## 你的角色）次之；
    // 成员花名册段（## 频道成员与委派）再次；剩余额度传给 injectContext。
    let skillSection = '';
    let skillTokens = 0;
    let skillMatched: string[] = [];
    try {
      const composed = await this.buildSkillSection(wu);
      skillSection = composed.section;
      skillTokens = composed.tokens;
      skillMatched = composed.matched;
    } catch {
      // Non-blocking: agent continues without skill section
    }

    // 决策 13: `## 你的角色` 段（persona ?? description；为空则省略）。纯字符串组装，不抛错
    const persona = this.buildPersonaSection(Math.max(0, INJECT_TOKEN_BUDGET - skillTokens));
    const personaSection = persona.section;
    const personaTokens = persona.tokens;

    let rosterSection = '';
    let rosterTokens = 0;
    try {
      const roster = await this.buildRosterSection(wu, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens));
      rosterSection = roster.section;
      rosterTokens = roster.tokens;
    } catch {
      // Non-blocking: agent continues without roster section
    }

    let knowledgeContext = '';
    let injectedKnowledgeIds: string[] = [];
    try {
      const ctx = await knowledgeService.injectContext(wu.type, {
        tags: [wu.type],
        maxTokens: Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens - rosterTokens),
      });
      knowledgeContext = ctx.prompt;
      injectedKnowledgeIds = ctx.injectedIds ?? [];
    } catch {
      // Non-blocking: agent continues without knowledge context
    }
    const leadSections = [skillSection, personaSection, rosterSection].filter(s => s.length > 0).join('\n\n');
    if (leadSections) {
      knowledgeContext = knowledgeContext
        ? `${leadSections}\n\n## 项目上下文\n${knowledgeContext}`
        : leadSections;
    }

    // Session management — per-WU session (RuntimeInstance.sessionId, cwd-scoped)
    const metadataUpdates: Partial<WorkUnitMetadata> = {};
    if (skillMatched.length > 0) {
      // 决策 7: step 时匹配名单落盘 metadata.matchedSkills（随 recordResult 原子写入，
      // 供 skill-demotion 成功率与被无视率度量——替代原 claim 时 fire-and-forget 落盘，消竞态）
      metadataUpdates.matchedSkills = skillMatched;
    }
    if (pendingReplies.length > 0) {
      // F5: 回复已注入 prompt，清除避免后续步骤重复注入（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.pendingReplies = undefined;
    }
    if (commitGuardHint) {
      // §10.5: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.commitGuardHint = undefined;
    }
    if (verifyFailHint) {
      // B3b-i: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.verifyFailHint = undefined;
    }
    if (childGuardHint) {
      // §6-2: 提示已注入 prompt，清除避免后续步骤重复注入
      metadataUpdates.childGuardHint = undefined;
    }
    // 续用判定（fix/guard-and-resume）：同一 WU 内才续用。claude 会话按 (HOME, cwd) 存储
    // （2.1.80 实测：异 cwd --resume 报 "No conversation found with session ID"）。
    // HOME 不再 per-agent 隔离（GAP-2 已移除），会话区分靠 cwd；token 由 process.env 透传。
    // B3b-i 每 WU 独立 worktree → 跨 WU 续用必失败；WU metadata.sessionId 由本 WU 首 step
    // 写入，与 instance.sessionId 相等才说明会话是在本 WU（同一 worktree/cwd）建立的。
    const resumeSessionId = this.instance?.sessionId && metadata.sessionId === this.instance.sessionId
      ? this.instance.sessionId
      : null;
    let newSessionId: string | null = null;
    if (!resumeSessionId) {
      // B5（2026-08-03 token-burn issue P1-1，决策记录 #3）：每 WU 会话数上限。
      // 新建会话 = 从零重读 SKILL.md/探索文件 + 后续 step 全文重放，是最大的 token 放大器；
      // 超限转 need_input 等人工评估，替代静默重开。人工回复由 resumeWaitingWorkUnit 重置 sessionCount。
      // 旧数据无 sessionCount 字段：已有 sessionId 的按已用 1 个计。
      const sessionsUsed = metadata.sessionCount ?? (metadata.sessionId ? 1 : 0);
      if (sessionsUsed >= MAX_SESSIONS_PER_WU) {
        logger.warn('[AgentLoop] Session limit reached — need human evaluation', {
          workUnitId: wu.id, sessionsUsed, max: MAX_SESSIONS_PER_WU,
        });
        return {
          action: 'need_input' as const,
          summary: `会话重建已达上限（${sessionsUsed}/${MAX_SESSIONS_PER_WU}）：反复从零重开会话会全文重放烧钱，已暂停自动执行。请人工评估后回复任意内容继续（回复会重置会话预算），或直接关闭任务`,
          metadataUpdates,
        };
      }
      newSessionId = randomUUID();
      metadataUpdates.sessionId = newSessionId;
      metadataUpdates.sessionCount = sessionsUsed + 1;
      metadataUpdates.startedAt = new Date().toISOString();
      // Persist sessionId to RuntimeInstance for cross-WorkUnit continuity
      if (this.instance) {
        await this.fileStore.updateState(this.instance.id, { sessionId: newSessionId });
        this.instance.sessionId = newSessionId;
      }
    } else {
      metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
    }

    // F6 → B3a: WorkUnit 绑定工程 → 解析执行根目录，经 parameters.workspaceRoot
    // 传给 agent-runner（resolveWorkspace Priority 1：直接以该目录为 cwd）。
    // metadata.workspaceRoot（B3a 归属链：Requirement→PMO gitRepo / 人工回复绑定）优先；
    // 否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）；都没有 → 不传，保持现有 fallback。
    //
    // B3b-i（决策 D1）：代码类 WU（task/bug/feature/refactor）解析出 git 仓库根后，
    // 不再直接改共享目录 —— 执行 cwd 换成该仓库的专属 worktree
    // （<worktreesDir>/wu-<wuId>，分支 task/<wuId>）。同一 WU 跨 step 复用：
    // 首个 step 创建并把 worktreePath/branch/baseBranch/baseRepo 记入 metadata，
    // 后续 step 经 ensureWuWorktree 按目录存在性复用。创建失败走 B1 失败分支
    // （action='failed' → consecutiveStuck → 3 次 blocked），绝不静默退回共享目录。
    // 解析不出 git 仓库（无绑定根 / 根目录无 .git）→ 维持现状。
    let workspaceRoot = await this.resolveExecutionWorkspaceRoot(wu, metadata);
    if (CODE_WORKTREE_TYPES.has(wu.type) && workspaceRoot && isGitRepoRoot(workspaceRoot)) {
      try {
        // PMO-b（决策 3）：WU 归属 PMO → base 从默认分支改为 PMO 分支（分支名 = PMO id），
        // per-WU 临时分支从 PMO 分支拉、向 PMO 分支合（merge-on-review-pass 消费 pmoBranch 落档）。
        // 解析/建支失败回落默认 base，绝不阻断执行。
        let pmoBaseBranch: string | null = null;
        const pmoResolution = await resolvePmoBranchForWU(wu, this.fileStore).catch(() => null);
        if (pmoResolution) {
          try {
            await ensureBranchExists({
              repoDir: workspaceRoot,
              branch: pmoResolution.branch,
              baseBranch: typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
                ? metadata.worktreeBaseBranch
                : getDefaultBranch(workspaceRoot),
            });
            pmoBaseBranch = pmoResolution.branch;
          } catch (err) {
            logger.warn(`[AgentLoop] PMO branch ensure failed, falling back to default base: ${err instanceof Error ? err.message : String(err)}`, { traceId });
          }
        }
        const info = await ensureWuWorktree({
          wuId: wu.id,
          repoDir: workspaceRoot,
          worktreesDir: resolveWorktreesDir(),
          baseBranch: pmoBaseBranch
            ?? (typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0
              ? metadata.worktreeBaseBranch
              : undefined),
        });
        if (metadata.worktreePath !== info.worktreePath) {
          metadataUpdates.worktreePath = info.worktreePath;
          metadataUpdates.worktreeBranch = info.branch;
          metadataUpdates.worktreeBaseBranch = info.baseBranch;
          metadataUpdates.worktreeBaseRepo = info.baseRepo;
          if (pmoResolution && pmoBaseBranch) {
            // 2026-08 归因统一：只落 pmoBranch（merge-on-review-pass 的合并目标）；
            // 项目 id 不再缓存落档（原 pmoProjectId 为冗余缓存），消费方经
            // resolvePmoProjectIdForWU 从创建期戳（metadata.pmoId / reqId）重解析
            metadataUpdates.pmoBranch = pmoResolution.branch;
          }
        }
        workspaceRoot = info.worktreePath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[AgentLoop] Worktree creation failed for ${wu.id}: ${message}`, { traceId });
        // 首 step 失败：会话未建立，重置避免下步 --resume 空 id
        if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
        return {
          action: 'failed' as const,
          summary: `worktree 创建失败: ${message.slice(0, 500)}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'worktree_creation_failed',
            errorDetail: message.slice(0, 500),
            errorAt: new Date().toISOString(),
          },
        };
      }
    } else if (wu.type === 'review') {
      // B3b-i: review WU 继承父 WU worktree（评审能看到 diff）；父无 worktree → 维持现状
      const parentWorktree = await this.resolveParentWorktreePath(wu);
      if (parentWorktree) workspaceRoot = parentWorktree;
    }

    // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
    const taskProvider = (this.role.provider || 'claude') as AgentTask['provider'];
    const executionId = `${wu.id}-${Date.now()}`;
    // 本步步号（与 recordResult 的 stepCount+1 同口径）——Layer A 执行步事件与 Layer B 步内流式共用
    const stepNo = (metadata.stepCount ?? 0) + 1;
    const task: AgentTask = {
      id: wu.id,
      executionId,
      // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
      // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
      provider: taskProvider,
      prompt,
      parameters: {
        // 续用：sessionId + sessionResume → cli-adapter 按 provider 换续用形态
        // （claude --resume <id>；kimi/opencode --continue、codex exec resume --last ——
        // Studio UUID 对这三家无意义，靠 CLI 自己的 cwd 维度会话记录续用，实证见 cli-adapter 头部）。
        // 新建：仅 claude 把新 sessionId 传给 CLI（--session-id 建会话 —— 不建则后续 --resume
        // 找不到会话，2.1.80 实测报 "No conversation found"）；kimi/codex/opencode 的 session
        // 参数均续用语义（实测未知 id 报 Session not found）→ 新建不传，CLI 自建会话。
        sessionId: resumeSessionId ?? (newSessionId && taskProvider === 'claude' ? newSessionId : undefined),
        ...(resumeSessionId ? { sessionResume: true } : {}),
        maxTurns: 50,
        knowledgeContext: knowledgeContext || undefined,
        agentRole: 'executor',
        workUnitId: wu.id,
        agentProfileId: this.role.id,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        extraEnv: {
          STUDIO_WORKUNIT_ID: wu.id,
          STUDIO_CHANNEL_ID: wu.channelId ?? '',
          STUDIO_TRACE_ID: traceId ?? '',
        },
      },
      timeoutMs: 120_000,
      // Layer B（WU 过程可视化）：步内 stream-json 行级透传 → SSE 实时过程。
      // fire-and-forget；仅 LocalExecutor 同进程有效（RemoteExecutor 函数不可序列化，丢弃）。
      onStreamLine: (line) => {
        void emitExecutionStreamLine({ workUnitId: wu.id, executionId, step: stepNo, line }).catch(() => {});
      },
    };

    // M2 成本红线度量 + B6 真实 token 记账（2026-08-03 token-burn issue P1-2）：
    // 成功与失败执行都记 workunit:tokens（失败照样烧 token）。fire-and-forget，绝不影响任务流程。
    const recordTokenEvent = (res: ExecutionResult): RealUsage | null => {
      const real = resolveRealUsage(res);
      void writeWorkunitTokenEvent(studioEventsJsonlPath(), {
        workUnitId: wu.id,
        executionId: task.executionId,
        injectedTokens: estimateTokens(knowledgeContext.length),
        executionTokens: real ? real.inputTokens + real.outputTokens : null,
        // D16/B6: 缓存命中与真实账单数据源（CLI 回报 usage 时才有；未回报则缺省不编造）
        ...(real ? {
          inputTokens: real.inputTokens,
          outputTokens: real.outputTokens,
          cacheReadTokens: real.cacheReadTokens,
          cacheCreationTokens: real.cacheCreationTokens,
          billedTokens: real.billedTokens,
          ...(real.costUsd ? { costUsd: real.costUsd } : {}),
          ...(real.numTurns ? { numTurns: real.numTurns } : {}),
        } : {}),
        // B6: 触发器来源落盘（按触发器聚合的输入）
        ...(typeof metadata.triggerId === 'string' && metadata.triggerId ? { triggerId: metadata.triggerId } : {}),
      }).catch(() => {});
      return real;
    };

    try {
      // Layer B: step 开始信号（CLI 首行到达前抽屉即有反馈）
      void emitExecutionStreamStepStart({ workUnitId: wu.id, executionId, step: stepNo }).catch(() => {});
      // §9.6: 经 Executor 接口执行（P0 恒为 LocalExecutor → agentRunner.executeLightweight）
      const result: ExecutionResult = await this.executor.execute(task);

      // W-3 接线：runner 失败时返回 { success:false } 而不抛错、且无 outputText ——
      // 直接落入 parseAgentOutput 会得到默认 progress（空 summary），导致 consecutiveStuck
      // 被清零、每 3s 重试、往频道发空消息。显式失败分支：action='failed'，由 recordResult
      // 记 consecutiveStuck + errorType/errorDetail，不发频道消息；连续 3 次走 blocked 路径。
      // 不带 channelVersion —— 失败不是发言，无需新鲜度检查（避免被降级为 progress）。
      if (result.success === false) {
        const detail = (result.error ?? '未知错误').slice(0, 500);
        logger.error(`[AgentLoop] agentStep execution failed for ${wu.id}: ${detail}`, { traceId });
        // B6: 失败执行同样记账（CLI 已跑的轮次照样烧了 token，runner error 路径透出 usage）
        recordTokenEvent(result);
        // 首 step 失败：会话未必已建立，重置避免下步 --resume 一个从未建立的会话
        if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
        return {
          action: 'failed' as const,
          summary: `CLI 执行失败: ${detail}`,
          metadataUpdates: {
            ...metadataUpdates,
            errorType: 'execution_failed',
            errorDetail: detail,
            errorAt: new Date().toISOString(),
          },
        };
      }

      const stepResult = parseAgentOutput(result.outputText ?? '');

      // 执行成功 → 清除上一轮失败标记（undefined 在 JSON 序列化时丢弃）
      metadataUpdates.errorType = undefined;
      metadataUpdates.errorDetail = undefined;
      metadataUpdates.errorAt = undefined;

      // M2 成本红线度量 + B6 真实记账: 每次 CLI 执行完成记一条 workunit:tokens 事件
      // （注入估算 chars/4 vs 2K 红线；执行 tokens 取 CLI 真实 usage，未回报记 null 不编造）。
      const realUsage = recordTokenEvent(result);

      // wireup④ token 预算数据源: 本次真实消耗（billed 口径，含 cache）累加进
      // metadata._cumulativeTokens，随 metadataUpdates 由 recordResult 单次原子写入。
      // CLI 未回报 usage（realUsage=null）按 0 累加——即保持既有累计值不变。
      metadataUpdates._cumulativeTokens = (metadata._cumulativeTokens ?? 0) + (realUsage?.billedTokens ?? 0);

      // T-1.1: Record tool:call events for PatternMiner data source
      // D18: 写入统一事件文件（~/.studio/logs/studio-events.jsonl）
      // R2-fix: outputText 是 extractResult 后的纯文本（不含 stream-json 事件行），
      // 必须优先取 rawOutput（原始 stdout）——否则 parseStreamEvents 恒产 0 条。
      const toolTraceSource = result.rawOutput ?? result.outputText;
      if (toolTraceSource) {
        try {
          writeToolCallEvents(toolTraceSource, resolveToolTraceFile());
        } catch { /* non-blocking */ }
      }

      // WU 过程可视化：执行步事件（本步思考/工具调用/skill 注入/用量 → 事件流落盘 + SSE，
      // WU 详情抽屉消费；不进频道、不写 metadata 防膨胀）。fire-and-forget。
      void emitExecutionStepEvent({
        workUnitId: wu.id,
        executionId: task.executionId,
        sessionId: resumeSessionId ?? newSessionId ?? undefined,
        step: stepNo,
        action: stepResult.action,
        rawOutput: toolTraceSource,
        skills: skillMatched,
      }).catch(() => {});

      // GAP-6: recordOutcome + extractFromExecution (non-blocking)
      // R1: 携带本次注入的知识条目 id，反馈环才有数据
      this.recordExecutionOutcome(wu, result, injectedKnowledgeIds).catch(() => {});

      // R3 会话提取（断点 B）：任务 COMPLETE → 触发一次 LLM 知识提取（proposal 入库，
      // 审核前不注入）。模板式 extractFromExecution 保留为始终在线的兜底，两条链路独立。
      // fire-and-forget：无 LLM 配置/提取失败仅记日志，绝不影响任务完成。
      // 去重：metadata.knowledgeExtractedAt 标记后不再重复提取（随 recordResult 原子写入持久化）。
      if (stepResult.action === 'complete' && !metadata.knowledgeExtractedAt) {
        metadataUpdates.knowledgeExtractedAt = new Date().toISOString();
        const conversation = [
          { role: 'user', content: wu.scope ?? '' },
          ...pendingReplies.map(content => ({ role: 'user', content })),
          { role: 'assistant', content: stepResult.summary },
        ];
        try {
          void knowledgeService.extractFromConversation?.(conversation, { workUnitId: wu.id })
            ?.catch((err: unknown) =>
              logger.warn(`[AgentLoop] extractFromConversation failed: ${err instanceof Error ? err.message : String(err)}`)
            );
        } catch { /* non-blocking */ }
      }

      // Session truncation: detect input_tokens exceeding threshold
      this.checkSessionTruncation(result.outputText, metadataUpdates);

      // P0 修复（reviewReport 回传断链）：review 子 WU 报告 COMPLETE 时，把 reviewer
      // 最终输出解析为结构化结论写入 metadata.reviewReport —— 这是 ReviewDispatcher
      // 路径 B 判定父 WU 过/拒的唯一数据源。解析失败不写（dispatcher 转人工，不误拒）。
      if (wu.type === 'review' && stepResult.action === 'complete') {
        const report = parseReviewReport(result.outputText ?? '');
        if (report) {
          metadataUpdates.reviewReport = report;
        } else {
          logger.warn(`[AgentLoop] Review WU ${wu.id} completed without parseable REVIEW_RESULT — 由 ReviewDispatcher 转人工`);
        }
      }

      // PMO 分析接力（analysis-handoff）：analysis WU COMPLETE 时解析 TASK: 拆分行
      // 写入 metadata.analysisTasks —— 人工确认（reviewPassed → done）后由
      // analysis-handoff 据此建未指派 task 子 WU（频道成员涌现认领 = 派工）。
      // 解析失败/无 TASK 行不写（确认后仅提示可手动拆，不阻断完成）。
      if (wu.type === 'analysis' && stepResult.action === 'complete') {
        const tasks = parseTaskBreakdown(result.outputText ?? '');
        if (tasks.length > 0) {
          metadataUpdates.analysisTasks = tasks;
        }
      }

      // AC-4.3/4.4: Cache tracking — extract input_tokens from result events
      const tokens = extractInputTokens(result.outputText ?? '');
      if (tokens !== null) {
        metadataUpdates.lastInputTokens = tokens;
      }

      return { ...stepResult, metadataUpdates, channelVersion };
    } catch (err) {
      // W-3 fix: executeLightweight 失败返回 { success:false } 不抛错 —— 已在上方
      // success===false 显式分支接线（consecutiveStuck → blocked）；本 catch 只覆盖
      // 真正抛出的异常（如 spawn 失败），保持 need_input 语义。
      // 首 step 抛异常：会话未建立，重置避免下步 --resume 空 id
      if (newSessionId) await this.resetUnestablishedSession(metadataUpdates);
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AgentLoop] agentStep execute failed: ${message}`, { traceId });
      // AC-8.7: 远程节点不可达 → need_input，由人工评估是否需要切换节点
      if (err instanceof RemoteNodeUnreachableError) {
        return {
          action: 'need_input' as const,
          summary: `远程节点不可达: ${message}`,
          metadataUpdates: { ...metadataUpdates, lastError: `remote-unreachable: ${this.executor instanceof RemoteExecutor ? (this.executor as any).nodeId : 'unknown'}` },
        };
      }
      return {
        action: 'need_input' as const, // increments consecutiveStuck
        summary: `Agent execution failed: ${message}`,
        metadataUpdates,
      };
    }
  }

  /**
   * §10 P0 + 决策 7/11: 组装 `## 本次任务 Skills` 段 —— step 时计算（不再读 claim 落盘的
   * metadata.matchedSkills，消竞态并吃到 skill 库最新版）。
   * 匹配（selectSkillsWithDomain）：+skill 显式点名（wu.scope 解析）> 域匹配
   * （role.acceptedTypes ∪ 归一化 wu.type ∩ skill.agentTypes）> scope 文本 > 其余按热度——
   * 产出相关度排序全量列表，由 2K 预算块级截断（取代封顶 3）。
   * index-on-demand：索引行 = name + description + triggers 摘要 + 全文指针
   * （~/.studio/skills/<name>/SKILL.md，agent 按需阅读），不注入正文；段首协议行说明按需语义。
   * 返回 matched = 实际进入注入段的 skill 名（调用方落盘 metadata.matchedSkills；
   * 此处并发 knowledge:skill_used 事件，fire-and-forget，供度量/被无视率）。
   */
  private async buildSkillSection(wu: WorkUnitData): Promise<{ section: string; tokens: number; matched: string[] }> {
    const manifest = loadManifest();
    if (manifest.length === 0) return { section: '', tokens: 0, matched: [] };

    const hints = parseSkillHintsFromScope(wu.scope ?? '');
    const ranked = selectSkillsWithDomain(wu.scope ?? '', manifest, {
      acceptedTypes: this.acceptedTypes,
      wuType: wu.type,
    }, hints);
    if (ranked.length === 0) return { section: '', tokens: 0, matched: [] };

    const header = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
    let tokens = estimateTokens(header.length);
    const blocks: string[] = [];
    const matched: string[] = [];
    for (const entry of ranked) {
      const triggerSummary = Array.isArray(entry.triggers) && entry.triggers.length > 0
        ? `｜触发：${entry.triggers.slice(0, 5).join(', ')}`
        : '';
      const block = `### ${entry.name}\n${entry.description || '（无描述）'}${triggerSummary}\n全文：~/.studio/skills/${entry.name}/SKILL.md`;
      const blockTokens = estimateTokens(block.length + 2); // + \n\n 分隔符
      if (tokens + blockTokens > INJECT_TOKEN_BUDGET) {
        // 首个块即超预算：截断塞入，保证段不为空（沿用原整段截断口径）
        if (blocks.length === 0) {
          blocks.push(block.slice(0, Math.max(0, (INJECT_TOKEN_BUDGET - tokens) * 4)));
          matched.push(entry.name);
          tokens = INJECT_TOKEN_BUDGET;
        }
        break;
      }
      blocks.push(block);
      matched.push(entry.name);
      tokens += blockTokens;
    }

    // 度量（fire-and-forget）：每个实际注入的 skill 记一条 knowledge:skill_used 事件
    for (const skillName of matched) {
      void metricsFileStore.appendJsonl(studioEventsJsonlPath(), {
        type: 'knowledge:skill_used',
        source: 'agent-loop',
        payload: JSON.stringify({ skillName, workUnitId: wu.id }),
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }

    return { section: `${header}\n\n${blocks.join('\n\n')}`, tokens, matched };
  }

  /**
   * 决策 13: 组装 `## 你的角色` 段（角色自述）。
   * 内容 = role.persona ?? role.description（皆空则段省略）；
   * 与 skill/roster/知识段共用 2K 红线（skills > persona > roster > knowledge），
   * 调用方传入剩余额度，超出按 chars/4 口径截断。
   */
  private buildPersonaSection(tokenBudget: number): { section: string; tokens: number } {
    const persona = this.role.persona ?? this.role.description;
    if (!persona || tokenBudget <= 0) return { section: '', tokens: 0 };

    let section = `## 你的角色\n\n${persona}`;
    let tokens = estimateTokens(section.length);
    if (tokens > tokenBudget) {
      section = section.slice(0, tokenBudget * 4);
      tokens = tokenBudget;
    }
    return { section, tokens };
  }

  /**
   * A2A §4.1 机制 2: 组装 `## 频道成员与委派` 段（成员花名册 + DELEGATE 协议教学）。
   * 花名册 = 本频道 active 成员的 name + description + provider（排除自己——委派质量取决于
   * 模型对角色能力的理解，没有花名册的 DELEGATE 是盲派）；members 为空（历史频道未回填）
   * 时回退到全部 active profile，与 DelegationGate 的过渡期口径一致。
   * 预算：与 skill/知识段共用 2K 红线，优先级 skills index > roster > knowledge——
   * 调用方传入 skill 之后的剩余额度，超出按 chars/4 口径截断。
   */
  private async buildRosterSection(wu: WorkUnitData, tokenBudget: number): Promise<{ section: string; tokens: number }> {
    if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0 };

    const channel = await this.fileStore.getChannel(wu.channelId);
    const memberIds = parseChannels(channel?.members);
    let members: AgentProfileData[];
    if (memberIds.length > 0) {
      const resolved = await Promise.all(memberIds.map(id => this.fileStore.getProfile(id).catch(() => null)));
      members = resolved.filter((p): p is AgentProfileData => !!p && p.status === 'active');
    } else {
      members = await this.fileStore.listProfiles({ status: 'active' });
    }
    members = members.filter(p => p.id !== this.role.id);
    if (members.length === 0) return { section: '', tokens: 0 };

    const rosterLines = members.map(p =>
      `- ${p.name}（provider: ${p.provider ?? 'claude'}）：${p.description || '（无描述）'}`
    );
    let section = `## 频道成员与委派

本频道可协作成员：
${rosterLines.join('\n')}

如需把一部分工作交给更合适的成员，输出一行：ACTION: DELEGATE:@<成员名>:<子任务 scope>（scope 为该行剩余内容）。仅可委派给上述成员，不可委派给自己；委派深度上限 ${resolveMaxDepth()} 跳（根任务 depth=0），同一任务最多委派 ${MAX_DELEGATIONS_PER_PARENT} 次，不可对同一成员重复委派。系统校验通过后会创建子任务并在频道发卡片，你继续按 PROGRESS 推进自己的部分；校验不通过则转为 NEED_INPUT 请人裁决。`;

    let tokens = estimateTokens(section.length);
    if (tokens > tokenBudget) {
      section = section.slice(0, tokenBudget * 4);
      tokens = tokenBudget;
    }
    return { section, tokens };
  }

  /**
   * B3a 归属链：执行根目录解析 — metadata.workspaceRoot（Requirement→PMO gitRepo /
   * 人工回复绑定的直接路径）优先；否则按 wu.workspaceId 查 workspace 记录（F6 旧路径）。
   */
  private async resolveExecutionWorkspaceRoot(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
    if (typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.length > 0) {
      return metadata.workspaceRoot;
    }
    return wu.workspaceId ? this.resolveBoundWorkspaceRoot(wu.workspaceId) : null;
  }

  /**
   * F6: 解析 WorkUnit 绑定工程的执行根目录（workspace.workspaceRoot）。
   * 记录缺失/无 workspaceRoot/读取失败 → null（保持未绑定的默认行为）。
   */
  private async resolveBoundWorkspaceRoot(workspaceId: string): Promise<string | null> {
    try {
      const root = await resolveWorkspaceRoot(workspaceId);
      if (!root) {
        logger.warn(`[AgentLoop] Bound workspace ${workspaceId} unresolved, falling back to default cwd`);
      }
      return root;
    } catch (err) {
      logger.warn(`[AgentLoop] Workspace resolution failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * B3b-i: review WU 继承父 WU 的 worktree 路径（评审在父 worktree 里执行，能看到 diff）。
   * 父缺失/无 worktreePath/读取失败 → null（维持现状）。
   */
  private async resolveParentWorktreePath(wu: WorkUnitData): Promise<string | null> {
    if (!wu.parentId) return null;
    try {
      const parent = await this.workUnitService.getById(wu.parentId);
      const parentMeta: WorkUnitMetadata = parseWuMetadata(parent?.metadata);
      return typeof parentMeta.worktreePath === 'string' && parentMeta.worktreePath.length > 0
        ? parentMeta.worktreePath
        : null;
    } catch {
      return null;
    }
  }

  /**
   * B3b-i: 提交守卫/自动验证的 git cwd 解析（recordResult 侧只读消费，不创建）。
   * 代码类 WU 有专属 worktree → 在 worktree 下跑 git status；
   * review WU → 父 WU worktree；否则回退 B3a/F6 的共享根解析。
   */
  private async resolveExecutionCwd(wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
    if (CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      return metadata.worktreePath;
    }
    if (wu.type === 'review') {
      const parentWorktree = await this.resolveParentWorktreePath(wu);
      if (parentWorktree) return parentWorktree;
    }
    return this.resolveExecutionWorkspaceRoot(wu, metadata);
  }

  /**
   * B3b-i（决策 D3 前半）验证命令解析与执行已抽到 ./wu-verification.js（F6-c）——
   * resolveVerifyCommands / runWuVerification 为模块级导出，行为不变。
   * §10.5 提交守卫的 git 探针（hasUncommittedChanges/readHeadHash）与收口守卫链
   * 已抽到 ./completion-gates.js（2026-08，行为不变）；resolveExecutionCwd /
   * listUnfinishedChildren 因绑定 workUnitService/fileStore 留在本类，经 deps 下传。
   */

  /** Record execution outcome to knowledge service (GAP-6, non-blocking).
   *  R1: consumedKnowledge = 本次 agentStep 经 injectContext 实际注入的知识条目 id。 */
  private async recordExecutionOutcome(wu: WorkUnitData, result: ExecutionResult, consumedKnowledge: string[] = []): Promise<void> {
    try {
      await knowledgeService.recordOutcome({
        executionId: wu.id,
        agentType: 'claude',
        consumedKnowledge,
        success: result.success,
        details: result.outputText?.slice(0, 500) ?? '',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-blocking
    }
    try {
      await knowledgeService.extractFromExecution({
        task: wu.scope ?? '',
        diff: result.outputText ?? '',
        success: result.success,
        duration: result.totalDurationMs ?? 0,
        agentType: 'claude',
        consumedKnowledge,
      });
    } catch {
      // Non-blocking
    }
  }

  /**
   * 首 step（新建会话）执行失败时重置 sessionId：CLI 会话未必已建立（可能根本没 spawn 到），
   * 不重置则下一步按续用发 `--resume <从未建立的 id>`（claude 必报 "No conversation found"）。
   * 续用 step 失败不调用 —— 会话已存在，保留下一步继续 resume。
   */
  private async resetUnestablishedSession(metadataUpdates: Partial<WorkUnitMetadata>): Promise<void> {
    if (this.instance) {
      this.instance.sessionId = null;
      await this.fileStore.updateState(this.instance.id, { sessionId: null }).catch(() => {});
    }
    delete metadataUpdates.sessionId;
    // B5: 会话未建立不计入会话预算（失败重试由 consecutiveStuck>=3 → blocked 兜底）
    delete metadataUpdates.sessionCount;
  }

  /** Check execution output for input_tokens exceeding threshold, reset session if needed */
  private checkSessionTruncation(outputText: string | undefined, metadataUpdates: Partial<WorkUnitMetadata>): void {
    if (!outputText || !this.instance) return;
    try {
      // Parse stream JSON events for usage data
      const lines = outputText.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'usage' && typeof event.input_tokens === 'number') {
            const inputTokens = event.input_tokens as number;
            if (inputTokens > SESSION_TOKEN_LIMIT) {
              logger.info(`[AgentLoop] Session truncation: ${inputTokens} tokens exceeds limit ${SESSION_TOKEN_LIMIT}`);
              this.instance.sessionId = null;
              this.fileStore.updateState(this.instance.id, { sessionId: null }).catch(() => {});
              delete metadataUpdates.sessionId;
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    } catch {
      // Non-blocking
    }
  }

  /** Record result: monitoring checkpoints + state transitions (zero token) */
  private async recordResult(target: Target, result: StepResult): Promise<void> {
    // B2: 测试特征 WU 守卫已在 agentStep 自行关闭 WU 并留痕，无需任何簿记/状态迁移
    if (result.action === 'skipped') return;
    const wuId = target.workUnit.id;
    const wu = await this.workUnitService.getById(wuId);
    if (!wu) return;

    // 提交守卫/自动验证必须以「持久化 + 本 step metadataUpdates」的合并视图为准
    // （首 step 的 worktreePath 尚未落库，只看持久化值会漏拦 → 假 complete；
    //   完整事故实录与 undefined-清除口径见 workunit/wu-metadata.ts mergedWuView）
    const metadata: WorkUnitMetadata = mergedWuView(wu.metadata, result.metadataUpdates);
    // P0 修复 6: traceId（与 agentStep 同一来源，供日志行携带）
    const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

    // 收口守卫链（§10.5 提交守卫 → §6-2 子任务守卫 → B3b-i 自动验证守卫）已抽到
    // ./completion-gates.js（行为一字不改，含守卫顺序/hint 写法/l1 台账/合并视图口径）——
    // recordResult 只保留编排：构建合并视图（上方）→ 跑守卫 → delegate/新鲜度/强制收口 →
    // 单次原子写 → 状态迁移与频道通知。git/子任务查询经 deps 注入（loop 绑定的两个方法下传）。
    const guards = await runCompletionGuards(
      { wu, wuId, metadata, action: result.action, roleId: this.role.id },
      {
        resolveExecutionCwd: (w, m) => this.resolveExecutionCwd(w, m),
        listUnfinishedChildren: id => this.listUnfinishedChildren(id),
      },
    );
    let action = guards.action;
    const guardUpdates = guards.guardUpdates;
    const noCommitNotice = guards.notices.noCommit;
    const verifyBlocked = guards.notices.verifyBlocked;
    const verifyPassNotice = guards.notices.verifyPassed;
    // F6-c：本 step COMPLETE 守卫是否已跑过验证 —— 下方步骤超限强制收口路径据此避免重复跑
    const verifyGuardRan = guards.notices.verifyGuardRan;

    // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）。
    // 通过：建子单 + collab 元数据 + delegate 卡片（父 WU 状态不变，按 progress 继续）；
    // 拒绝：降级 NEED_INPUT（现有 blocked 路径），频道发「拟委派…需人工确认」请人裁决。
    if (action === 'delegate' && result.delegate) {
      const gate = await checkDelegation({
        fileStore: this.fileStore,
        parent: wu,
        delegator: this.role,
        targetName: result.delegate.targetName,
      });
      if (gate.pass && gate.target) {
        const parentCollab = effectiveParentCollab(wu, this.role.id);
        const childCollab: CollabMeta = {
          rootId: parentCollab.rootId,
          depth: parentCollab.depth + 1,
          chain: [...parentCollab.chain, gate.target.id],
          delegatedBy: { profileId: this.role.id, workUnitId: wuId },
          delegationCount: 0,
        };
        await this.workUnitService.create({
          scope: result.delegate.scope,
          type: wu.type,
          parentId: wuId,
          assigneeId: gate.target.id, // unassigned 语义 = 目标 profile id（同 @mention 点名，§1.2-b）
          channelId: wu.channelId,
          projectPath: wu.projectPath,
          workspaceId: wu.workspaceId ?? null,
          reqId: wu.reqId ?? null,
          status: 'unassigned',
          metadata: { creationMode: 'agent-delegate', collab: childCollab },
        });
        // 父 WU 补记/累加 collab（根 WU 首次委派时从无 collab 合并为 depth=0 的根记录）
        guardUpdates.collab = { ...parentCollab, delegationCount: (parentCollab.delegationCount ?? 0) + 1 };
        action = 'progress';
        // delegate 卡片即本步的 progress 消息（走下方统一回帖路径，含新鲜度检查）
        result.summary = `@${this.role.name} 委派 @${gate.target.name}：${result.delegate.scope}（深度 ${childCollab.depth}/${resolveMaxDepth()}）`;
        logger.info(`[AgentLoop] Delegation created: ${wuId} → @${gate.target.name} (depth ${childCollab.depth})`);
      } else {
        action = 'need_input';
        result.summary = `拟委派 @${result.delegate.targetName}：${result.delegate.scope}，因 ${gate.reason ?? '未知原因'} 需人工确认`;
        logger.info(`[AgentLoop] Delegation rejected for ${wuId}: ${gate.reason}`);
      }
    }

    // §4.2 发言层新鲜度检查（仅 recordResult → postToDiscussionSpace 结果回帖路径，系统通知不受影响）：
    // step 期间房间有外部新消息 → 不直接发帖，新消息写入 pendingReplies 注入下一轮 prompt，
    // 本步按 progress 处理；同一结果连续 2 次被拦截仍判定要发 → 照发并注明「发送时房间有新消息」。
    let skipResultPost = false;
    const freshnessUpdates: Partial<WorkUnitMetadata> = {};
    if (result.channelVersion && wu.channelId) {
      const arrived = await this.fileStore.getMessagesSinceLine(wu.channelId, result.channelVersion.lineCount);
      // 本 loop 自己发的消息（如 delegate 卡片）不算「房间已变」
      const external = arrived.filter(m => !(m.authorType === 'agent' && m.agentName === this.role.name));
      const interrupts = metadata.freshnessInterrupts ?? 0;
      if (external.length > 0 && interrupts < 2) {
        skipResultPost = true;
        action = 'progress';
        freshnessUpdates.pendingReplies = external.map(m =>
          m.authorType === 'agent' ? `[${m.agentName ?? 'agent'}]: ${m.content}` : m.content
        );
        freshnessUpdates.freshnessInterrupts = interrupts + 1;
        logger.info(`[AgentLoop] Freshness: result post held for ${wuId} (${external.length} new message(s), interrupt ${interrupts + 1}/2)`);
      } else {
        if (external.length > 0) {
          result.summary = `${result.summary}（发送时房间有新消息）`;
        }
        if (interrupts > 0) {
          freshnessUpdates.freshnessInterrupts = 0;
        }
      }
    }

    const stepCount = (metadata.stepCount ?? 0) + 1;
    let consecutiveStuck = action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

    // F6-c（断点 1）：步骤超限强制收口前补跑 L1 —— COMPLETE 验证守卫只在 action=complete 时跑，
    // 超限路径（任意 action）此前完全跳过验证，代码类 WU 被强制 in_review 时永远缺 l1。
    // 台账写法与 COMPLETE 守卫同结构（approved 全绿 + verifyReport / rejected 留痕），
    // 但不计 verifyFailCount、不改 blocked 语义——仍按原计划进 in_review 交人工。
    // 本 step COMPLETE 守卫已跑过验证时不重复跑；无命令可跑 → 不写 attestation（维持现状）。
    // attestation 合进下方同一次 metadata 原子写回，不单独写库（防竞态）。
    const forceClosing = stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT);
    if (forceClosing && !verifyGuardRan
      && CODE_WORKTREE_TYPES.has(wu.type)
      && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
      const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
      if (outcome.failure) {
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'rejected',
          by: this.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
        });
        logger.info(`[AgentLoop] Force-close verify: l1 rejected for ${wuId} (command failed: ${outcome.failure.command})`);
      } else if (outcome.ran.length > 0) {
        guardUpdates.verifyReport = {
          commands: outcome.ran,
          source: outcome.source,
          passedAt: new Date().toISOString(),
        };
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: this.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        logger.info(`[AgentLoop] Force-close verify: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }

    // F5: NEED_INPUT 挂起标记（等待人类回复）；其他结果清除挂起标记（恢复后继续执行）
    const waitingUpdates: Partial<WorkUnitMetadata> = action === 'need_input'
      ? {
          waitingForInput: true,
          waitingQuestion: result.summary,
          waitingSince: new Date().toISOString(),
          waitingReminded: false,
        }
      : metadata.waitingForInput
        ? { waitingForInput: false, waitingReminded: false }
        : {};

    // B4（2026-08-03 token-burn issue P0-2）：blocked 原因落盘 —— 审计类 WU 全部 blocked
    // 却无据可查的事故教训；本步不走 blocked 路径时清除陈旧原因（恢复执行即翻篇）。
    const blockReasonUpdates: Partial<WorkUnitMetadata> = {};
    if (verifyBlocked) {
      blockReasonUpdates.blockReason = `verify-failed x${guardUpdates.verifyFailCount}: 自动验证连续失败`;
    } else if (consecutiveStuck >= 3) {
      blockReasonUpdates.blockReason = action === 'failed' && result.summary
        ? `stuck: 连续 3 步无进展（${result.summary.slice(0, 200)}）`
        : 'stuck: 连续 3 步无进展';
    } else if (action === 'need_input') {
      blockReasonUpdates.blockReason = `need-input: ${result.summary.slice(0, 200)}`;
    } else if (metadata.blockReason) {
      blockReasonUpdates.blockReason = undefined; // undefined 在 JSON 序列化时丢弃 → 清除
    }

    // Single atomic metadata write: merges agentStep updates (sessionId/startedAt/sessionResumes)
    // with monitoring counters (stepCount/consecutiveStuck) — fixes C-3 non-atomic write
    await this.workUnitService.update(wuId, {
      metadata: { ...metadata, ...result.metadataUpdates, ...waitingUpdates, ...guardUpdates, ...freshnessUpdates, ...blockReasonUpdates, stepCount, consecutiveStuck },
    });

    // P0 修复 6: trace 锚点 — 有 traceId 的 WU（频道消息链路）每步留一条可 grep 日志
    if (traceId) {
      logger.info(`[AgentLoop] Step recorded for ${wuId}`, { traceId, action, stepCount });
    }

    // §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零，之后每 3 步再提醒）
    if (noCommitNotice) {
      await this.postToDiscussionSpace(wuId, `任务 ${wuId} 连续 3 步无新提交，请注意及时 commit`);
    }

    // B3b-i: 自动验证连续失败 ≥3 次 → blocked 并频道说明（优先于 step limit / 状态迁移）
    if (verifyBlocked) {
      if (wu.status !== 'blocked') {
        await this.workUnitService.transitionStatus(wuId, 'blocked');
      }
      // 2026-07 PMO-flow UX（§6-3）：验证失败打回/转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      await this.postToDiscussionSpace(
        wuId,
        `自动验证连续失败 ${guardUpdates.verifyFailCount} 次，任务已转 blocked，等待人类介入。最近失败命令与输出已记录到任务上下文`,
        wu,
      );
      return;
    }

    // B3b-i: 验证全绿 → 频道简报（跑了哪几条；仅当 COMPLETE 未被其他守卫拦截）
    if (verifyPassNotice && action === 'complete') {
      await this.postToDiscussionSpace(wuId, verifyPassNotice);
    }

    // Monitoring: step limit（review WU 用放宽阈值，见 REVIEW_STEP_LIMIT 注释）
    if (stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT)) {
      // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
      if (wu.status === 'blocked') {
        await this.workUnitService.transitionStatus(wuId, 'active');
      }
      await this.workUnitService.transitionStatus(wuId, 'in_review');
      await this.postToDiscussionSpace(wuId, '步骤数超限，强制提交审查');
      return;
    }
    // Monitoring: stuck detection
    if (consecutiveStuck >= 3) {
      await this.workUnitService.transitionStatus(wuId, 'blocked');
      // W-3 接线：执行失败导致的 blocked 在频道说明失败原因（summary 含 CLI 错误详情）
      const stuckReason = action === 'failed' && result.summary ? `（${result.summary}）` : '';
      // 2026-07 PMO-flow UX（§6-3）：blocked 转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      await this.postToDiscussionSpace(wuId, `连续 3 步无进展${stuckReason}，等待人类介入`, wu);
      return;
    }

    // State transitions by action (§10.5: 使用守卫降级后的 action；§4.2: 新鲜度拦截时不发帖)
    // 非空守卫：summary 为空（如 CLI 成功但无文本输出）不发帖，避免频道空消息。
    switch (action) {
      case 'progress':
        if (!skipResultPost && result.summary.trim().length > 0) await this.postToDiscussionSpace(wuId, result.summary);
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        break;
      case 'complete':
        // 2026-07 PMO-flow UX（§6-3）：COMPLETE 完成汇报里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        if (!skipResultPost && result.summary.trim().length > 0) {
          await this.postToDiscussionSpace(wuId, result.summary, wu);
        }
        // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
        if (wu.status === 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'active');
        }
        await this.workUnitService.transitionStatus(wuId, 'in_review');
        // P0 修复（reviewReport 回传断链）：review 子 WU 不再被二次评审
        // （ReviewDispatcher 路径 A 跳过 type=review），complete 后直接收口 done，
        // 触发路径 B 读取 metadata.reviewReport 判定父 WU reviewPassed/reviewRejected。
        if (wu.type === 'review') {
          await this.workUnitService.transitionStatus(wuId, 'done');
        }
        break;
      case 'need_input':
        // 2026-07 PMO-flow UX（§6-3）：NEED_INPUT 里程碑 —— meta 带 pmoId（可解析时）+ atHuman
        if (!skipResultPost) {
          await this.postToDiscussionSpace(wuId, `需要输入: ${result.summary}`, wu);
        }
        // F5: 挂起 — 守卫重复 NEED_INPUT（blocked → blocked 不在 VALID_TRANSITIONS 中）
        if (wu.status !== 'blocked') {
          await this.workUnitService.transitionStatus(wuId, 'blocked');
        }
        break;
      case 'failed':
        // W-3 接线：CLI 执行失败 —— 不发频道消息、不做状态迁移（保持 active 待重试）；
        // consecutiveStuck 已在上方累计，满 3 次走 blocked 路径并说明失败原因。
        break;
    }
  }

  /** §6-2 父 complete 守卫：未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  private async listUnfinishedChildren(wuId: string): Promise<string[]> {
    const snapshots = await this.fileStore.getIndex();
    return snapshots
      .filter(s => s.parentId === wuId && !['done', 'closed'].includes(s.status))
      .map(s => s.id);
  }

  /** Post message to discussion space（经 wu-messenger → ChannelMessageService：eventBus + SSE，频道页实时可见）。
   *  milestoneWu 存在时按里程碑消息处理（2026-07 PMO-flow UX §6-3：meta 带 pmoId?/atHuman，普通 progress 不带）；
   *  2026-08 归因统一后解析链只读创建期持久化数据（metadata.pmoId / reqId），调用方直接传持久化 wu 本体，
   *  不再需要「持久化 + 本 step metadataUpdates」合并视图。 */
  private async postToDiscussionSpace(workUnitId: string, content: string, milestoneWu?: WorkUnitData): Promise<void> {
    if (!content.trim()) return;
    const wu = milestoneWu ?? await this.workUnitService.getById(workUnitId);
    if (!wu) return;

    // 绑定本 loop 的 fileStore（测试注入临时 store；生产与全局同目录），事件形状与全局 service 一致
    await postWuSystemMessage(wu, content, {
      agentName: this.role.name,
      fileStore: this.fileStore,
      ...(milestoneWu ? { milestone: true } : {}),
    });
  }

}

// ─── Exported pure functions (testable) ───

/** Extract input_tokens from stream-json result events */
export function extractInputTokens(outputText: string): number | null {
  const lines = outputText.split('\n');
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'result' && typeof event.input_tokens === 'number') {
        return event.input_tokens as number;
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  return null;
}

/** Check if a process is alive by sending signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** B3b-i: 判断路径是否 git 仓库根（.git 存在即可，与 createWorktree 校验口径一致） */
export function isGitRepoRoot(root: string): boolean {
  try {
    return existsSync(join(root, '.git'));
  } catch {
    return false;
  }
}

/** B3b-i: worktrees 根目录解析（与 AgentRunner config 口径一致：WORKTREES_DIR > ~/worktrees） */
export function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || join(os.homedir(), 'worktrees');
}

/** Resolve target from observations (pure code, zero LLM) */
export function resolveTarget(obs: Observations): Target | null {
  // Priority 1: human reply (including blocked WorkUnit)
  if (obs.newReplies.length > 0) {
    const repliedWuId = obs.newReplies[0].workUnitId;
    const wu = obs.myActive.find(w => w.id === repliedWuId);
    if (wu) return { workUnit: wu, newReplies: obs.newReplies };
  }

  // Priority 2: active WorkUnit continues
  const activeWu = obs.myActive.find(w => w.status === 'active');
  if (activeWu) return { workUnit: activeWu };

  // Priority 3: idle, take earliest unassigned
  if (obs.unassigned.length > 0) {
    return { workUnit: obs.unassigned[0] };
  }

  // No target
  return null;
}

/** Parse agent output for ACTION protocol */
export function parseAgentOutput(text: string): StepResult {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // A2A §4.1: ACTION: DELEGATE:@<profileName>:<scope>（scope = 该行剩余内容，必填）。
    // 解析失败（@名字缺失、scope 为空、格式不对）落到下方默认 progress，与现有容错一致。
    const delegateMatch = lines[i].match(/ACTION:\s*DELEGATE:@([\w-]+):(\s*\S.*)$/);
    if (delegateMatch) {
      const scope = delegateMatch[2].trim();
      return { action: 'delegate', summary: scope, delegate: { targetName: delegateMatch[1], scope } };
    }
    const match = lines[i].match(/ACTION:\s*(PROGRESS|COMPLETE|NEED_INPUT):(.*)/);
    if (match) {
      const actionMap: Record<string, StepResult['action']> = {
        PROGRESS: 'progress',
        COMPLETE: 'complete',
        NEED_INPUT: 'need_input',
      };
      return { action: actionMap[match[1]], summary: match[2].trim() };
    }
  }
  return { action: 'progress', summary: text.trim() };
}

/** Dynamic sleep interval based on result */
export function dynamicInterval(result: { action: string }): number {
  switch (result.action) {
    case 'progress':   return 3_000;
    case 'delegate':   return 3_000; // A2A: 委派后父按 progress 继续
    case 'complete':   return 10_000;
    case 'need_input': return 30_000;
    case 'failed':     return 15_000; // W-3: 失败重试降速（原误判 progress 时每 3s 重试）
    default:           return 15_000;
  }
}

/**
 * P0 修复（reviewReport 回传断链）：解析 reviewer 最终输出为结构化审查结论。
 * 约定格式（已写入 review 子 WU scope）：输出以
 *   REVIEW_RESULT: {"verdict":"pass"|"reject","summary":"...","issues":[...]}
 * 结尾的行。宽松策略：优先解析 REVIEW_RESULT 行 JSON；失败则从输出尾部提取
 * verdict 关键词；仍失败 → null（不写 reviewReport，由 ReviewDispatcher 转人工）。
 * verdict 词表归 review-contract.ts 所有（needs-info 无 legacy 等价 → 解析层不落档）；
 * 返回形状 ParsedReviewReport 同由契约模块定义。
 */
export function parseReviewReport(text: string): ParsedReviewReport | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/REVIEW_RESULT:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { verdict?: unknown; summary?: unknown; issues?: unknown };
      if (parsed.verdict === 'pass' || parsed.verdict === 'reject') {
        return {
          approved: parsed.verdict === 'pass',
          reason: typeof parsed.summary === 'string' ? parsed.summary : undefined,
          issues: normalizeReviewIssues(parsed.issues),
        };
      }
    } catch { /* JSON 损坏 → 落到关键词兜底 */ }
    break; // 已找到（最末一条）REVIEW_RESULT 行，不再向上扫描更早的行
  }

  // 兜底：输出尾部 verdict 关键词（ reviewer 未按约定格式但给出了结论词）
  const tail = lines.slice(-10).join('\n');
  if (/verdict["'\s:]+reject/i.test(tail)) {
    return { approved: false, reason: '（关键词兜底判定）' };
  }
  if (/verdict["'\s:]+pass/i.test(tail)) {
    return { approved: true, reason: '（关键词兜底判定）' };
  }
  return null;
}

/** REVIEW_RESULT issues 字段归一化：只保留 { severity, message } 形状，非法项丢弃 */
function normalizeReviewIssues(raw: unknown): Array<{ severity: string; message: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const issues = raw
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object')
    .map(i => ({
      severity: typeof i.severity === 'string' ? i.severity : 'info',
      message: typeof i.message === 'string' ? i.message : JSON.stringify(i),
    }))
    .filter(i => i.message.length > 0);
  return issues.length > 0 ? issues : undefined;
}

/** analysis 任务拆分上限（防模型刷行刷屏；常量定义在 workunit.service，此处复用） */
const ANALYSIS_TASK_MAX_CHARS = 300;

/**
 * PMO 分析接力：解析 analysis WU 输出中的 TASK: 拆分行（约定见 publish 的 scope 契约）。
 * 每行一条 `TASK: <任务描述>`；去空白/去重/封顶 8 条/单条截 300 字符；
 * 无 TASK 行返回 []（调用方据此不写 analysisTasks，不阻断 COMPLETE）。
 */
export function parseTaskBreakdown(text: string): string[] {
  const tasks: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*TASK:\s*(\S.*)$/);
    if (!match) continue;
    const task = match[1].trim().slice(0, ANALYSIS_TASK_MAX_CHARS);
    if (!task || seen.has(task)) continue;
    seen.add(task);
    tasks.push(task);
    if (tasks.length >= ANALYSIS_TASKS_MAX) break;
  }
  return tasks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt builders ───

function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入

当做出设计决策（选型、架构选择、方案取舍）时，用 Write 工具追加到 ~/.studio/knowledge/decision-YYYY-MM-DD.md 记录：话题、候选方案、选择、理由。`;
}

function buildReplyPrompt(wu: WorkUnitData, replies: string[]): string {
  const replyText = replies.join('\n');
  return `## 当前工作

${wu.scope}

## 人类新回复

${replyText}

## 要求

根据回复调整方案，继续工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入`;
}

// ─── Knowledge search analysis (preserved from original) ───

/**
 * Analyze agent log for knowledge search behavior.
 * Pure function — takes log content string, no file I/O.
 */
export function analyzeKnowledgeSearch(logContent: string): KnowledgeSearchAnalysis {
  const events = parseStreamEvents(logContent);
  const toolCalls = extractToolCalls(events);

  const searchCalls: Array<{ tool: string; detail?: string }> = [];
  for (const call of toolCalls) {
    const detail = getKnowledgeSearchDetail(call.name, call.input);
    if (detail !== null) {
      searchCalls.push({ tool: call.name, detail });
    }
  }

  return { searched: searchCalls.length > 0, searchCalls };
}

function getKnowledgeSearchDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;

  if (toolName === 'Read') {
    const fp = inp.file_path;
    if (typeof fp === 'string' && fp.includes('.studio/knowledge')) return fp;
  }
  if (toolName === 'Bash') {
    const cmd = inp.command;
    if (typeof cmd === 'string' && cmd.includes('.studio/knowledge')) return cmd;
  }
  if (toolName === 'Glob') {
    const pattern = inp.pattern;
    if (typeof pattern === 'string' && pattern.includes('.studio/knowledge')) return pattern;
  }

  return null;
}

/**
 * Extract knowledge entry IDs from search analysis results.
 * Parses file paths from Read/Bash tool call details.
 */
export function extractKnowledgeEntryIds(analysis: KnowledgeSearchAnalysis): string[] {
  const ids: string[] = [];
  for (const call of analysis.searchCalls) {
    if (!call.detail) continue;
    const match = call.detail.match(/\.studio\/knowledge\/([^/\s]+(?:\/[^/\s]+)?\.md)/);
    if (match) {
      const filePart = match[1];
      if (filePart === '_index.md' || filePart.endsWith('/_index.md')) continue;
      ids.push(filePart.replace(/\.md$/, ''));
    }
  }
  return Array.from(new Set(ids));
}

// ─── workunit:tokens event recording (M2) ───

export interface WorkunitTokenEventArgs {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（调用方按 chars/4 约定估算，与 estimateTokens 一致） */
  injectedTokens: number;
  /**
   * 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null ——
   * 聚合端据此把该事件排除在执行 tokens/开销比均值外（executionSource='unavailable'），不编造 0。
   * 口径警告：delegation-gate 树预算（TREE_TOKEN_BUDGET=400K）按本字段校准，禁止改成含 cache；
   * 账单/熔断口径看 billedTokens / totalTokens（2026-08-03 token-burn issue B6）。
   */
  executionTokens: number | null;
  /** LLM 提取 tokens（可选；R3 提取异步入库，通常由 knowledge:extraction 事件单独度量） */
  extractionTokens?: number;
  /** D16: CLI usage 的 input tokens（缓存命中率分子分母用；有 usage 时写入） */
  inputTokens?: number;
  /** B6: CLI usage 的 output tokens（此前只记 input/cache，输出无账） */
  outputTokens?: number;
  /** D16: CLI usage 的 cache read / creation tokens（缓存命中率用；有 usage 时写入） */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** B6: 真实账单口径 = input+output+cacheRead+cacheCreation（有 usage 时写入） */
  billedTokens?: number;
  /** B6: CLI 回报的美元成本 / 轮数（modelUsage 可得时写入） */
  costUsd?: number;
  numTurns?: number;
  /** B6: 触发器来源（trigger 创建的 WU；按触发器聚合的输入） */
  triggerId?: string;
}

/** B6: 一次执行的真实 token 用量（账单口径，含 cache） */
export interface RealUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input+output+cacheRead+cacheCreation —— 账单/预算熔断口径 */
  billedTokens: number;
  costUsd?: number;
  numTurns?: number;
}

/**
 * B6（2026-08-03 token-burn issue P1-2）：真实 usage 解析链。
 * 优先 modelUsage 累积（parseSessionMetrics 读 result 事件的 modelUsage.* —— 多轮会话全量；
 * 顶层 usage.* 仅最后一轮，extractUsage 只见到它，是此前 cache_read 无账的结构性原因之一）；
 * 兜底 runner 透出的 extractUsage 聚合（无 rawOutput 的失败路径）；全零 → null（不编造）。
 */
export function resolveRealUsage(result: ExecutionResult): RealUsage | null {
  if (result.rawOutput) {
    const m = parseSessionMetrics(result.rawOutput);
    if (m.tokenInput + m.tokenOutput + m.tokenCacheRead + m.tokenCacheWrite > 0) {
      return {
        inputTokens: m.tokenInput,
        outputTokens: m.tokenOutput,
        cacheReadTokens: m.tokenCacheRead,
        cacheCreationTokens: m.tokenCacheWrite,
        billedTokens: m.tokenInput + m.tokenOutput + m.tokenCacheRead + m.tokenCacheWrite,
        ...(m.costUsd ? { costUsd: m.costUsd } : {}),
        ...(m.numTurns ? { numTurns: m.numTurns } : {}),
      };
    }
  }
  const u = result.usage;
  if (u && u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens > 0) {
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
      billedTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
    };
  }
  return null;
}

/**
 * M2: 写一条 workunit:tokens 事件（模块级函数，供 agent-loop 与单测直接调用）。
 * totalTokens = injectedTokens + (billedTokens ?? executionTokens ?? 0)
 * （B6：billed 含 cache 是账单口径；executionTokens 保持 input+output 旧语义供树预算闸门用）。
 */
export async function writeWorkunitTokenEvent(eventsFile: string, args: WorkunitTokenEventArgs): Promise<void> {
  const executionTokens = typeof args.executionTokens === 'number' && Number.isFinite(args.executionTokens)
    ? args.executionTokens
    : null;
  const billedTokens = typeof args.billedTokens === 'number' && Number.isFinite(args.billedTokens)
    ? args.billedTokens
    : null;
  await metricsFileStore.appendJsonl(eventsFile, {
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({
      workUnitId: args.workUnitId,
      executionId: args.executionId,
      injectedTokens: args.injectedTokens,
      injectedSource: 'estimate:chars/4',
      executionTokens,
      executionSource: executionTokens !== null || billedTokens !== null ? 'cli-usage' : 'unavailable',
      totalTokens: args.injectedTokens + (billedTokens ?? executionTokens ?? 0),
      ...(typeof args.extractionTokens === 'number' ? { extractionTokens: args.extractionTokens } : {}),
      ...(typeof args.inputTokens === 'number' ? { inputTokens: args.inputTokens } : {}),
      ...(typeof args.outputTokens === 'number' ? { outputTokens: args.outputTokens } : {}),
      ...(typeof args.cacheReadTokens === 'number' ? { cacheReadTokens: args.cacheReadTokens } : {}),
      ...(typeof args.cacheCreationTokens === 'number' ? { cacheCreationTokens: args.cacheCreationTokens } : {}),
      ...(billedTokens !== null ? { billedTokens } : {}),
      ...(typeof args.costUsd === 'number' ? { costUsd: args.costUsd } : {}),
      ...(typeof args.numTurns === 'number' ? { numTurns: args.numTurns } : {}),
      ...(args.triggerId ? { triggerId: args.triggerId } : {}),
    }),
    createdAt: new Date().toISOString(),
  });
  // C3: 进程内当日预算计数器累加（口径与熔断扫描一致 = billed ?? total），
  // 仅在落盘成功后计；未 bootstrap/跨天由 daily-token-budget 自重扫收敛。
  noteTokensWritten(eventsFile, billedTokens ?? (args.injectedTokens + (executionTokens ?? 0)));
}

// ─── tool:call event recording ───

/**
 * D18 事件入口统一: tool:call trace 写入统一事件文件
 * （~/.studio/logs/studio-events.jsonl，测试期经 studio-log-path 隔离）。
 * 懒解析以支持运行时/测试注入 env。
 */
export function resolveToolTraceFile(): string {
  return resolveStudioEventsFile();
}

/**
 * Write tool:call events extracted from stream-json output to a JSONL file.
 * Returns the count of tool calls written.
 * T-1.1: Wiring tool:call recording for PatternMiner data source.
 * D18: StudioEvent 形态（payload 嵌套），与 daemon/task-executor 的 tool:call 一致。
 */
export function writeToolCallEvents(outputText: string, filePath: string): number {
  const events = parseStreamEvents(outputText);
  const toolCalls = extractToolCalls(events);
  if (toolCalls.length === 0) return 0;

  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  for (const call of toolCalls) {
    const event = JSON.stringify({
      type: 'tool:call',
      source: 'agent-loop',
      payload: JSON.stringify({
        tool: call.name,
        success: true,
        durationMs: 0,
        timestamp: now,
        caller: 'agent-loop',
      }),
      createdAt: new Date(now).toISOString(),
    });
    appendFileSync(filePath, event + '\n', 'utf-8');
  }

  return toolCalls.length;
}
