// Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6)
import { FileStore } from '@dommaker/studio-shared';
import type { AuditReport, FlywheelMetrics } from '../knowledge/knowledge-service.js';
import type { ProjectData } from '../pmo/project.service.js';
import * as os from 'node:os';
import * as path from 'node:path';
// #342：窗口读口（尾部倒读 + 窗口外早停）——getOverheadStats 事件读切到此读口
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';
// #318：WU 聚合上下文提取为共享出口（agent-loop 的 instance status_changed 负载同源）
import {
  loadCurrentWuContexts,
  type CurrentWuContext,
  type AgentCurrentWorkUnit,
  type AgentPmoSummary,
} from './current-wu-context.js';

export type { AgentCurrentWorkUnit, AgentPmoSummary };

/** M2 成本红线（vision §3）：知识/约束注入 ≤ 2K tokens/任务 */
export const INJECTED_TOKEN_BUDGET = 2_000;
/** M2 成本红线（vision §3）：单任务总 token ≤ 直连 CLI 的 1.2x → 封装增量部分 ≤ 0.2 */
export const OVERHEAD_RATIO_BUDGET = 0.2;

/** KnowledgeService 度量面（DI 注入用；缺省 lazy 取生产单例，避免模块加载期副作用） */
export interface KnowledgeMetricsSource {
  getFlywheelMetrics(opts?: { eventsFile?: string; windowDays?: number }): Promise<FlywheelMetrics>;
  getAuditReport(opts?: { eventsFile?: string; windowDays?: number }): Promise<AuditReport>;
}

/** M1: 飞轮指标（knowledge-service 实算的透传 + proposal 待审数 + 提取活动） */
export interface FlywheelStats {
  quality: number;
  hitRate: number;
  improvement: number;
  freshness: number;
  /** 事件衍生指标（hitRate/improvement）数据来源：'events' 实算 / 'insufficient-data' 显式 0 占位 */
  source: 'events' | 'insufficient-data';
  /** maturity=draft 的 proposal 数（审核前不参与注入） */
  proposalsPendingReview: number;
  extraction: { count30d: number; totalTokens30d: number };
  windowDays: number;
  timestamp: string;
}

/** M2: 封装开销度量（workunit:tokens 事件聚合，窗口默认 30 天） */
export interface OverheadStats {
  windowDays: number;
  /** workunit:tokens 事件数（每次 CLI 执行完成写一条） */
  executions: number;
  /** 涉及的 distinct workUnit 数 */
  workUnits: number;
  /** 平均每任务注入估算 tokens（TokenEstimator 口径，agent-loop 写入） */
  avgInjectedTokens: number;
  /** 注入红线 = 2000（vision §3） */
  injectedBudget: number;
  /** avgInjectedTokens / injectedBudget × 100（>100 即越红线） */
  injectedBudgetUsedPct: number;
  /** 有 CLI usage 回报的执行平均总 tokens（input+output）；全部未回报 → null（不编造） */
  avgExecutionTokens: number | null;
  /** 有执行 tokens 数据的事件占比（0-100） */
  executionCoveragePct: number;
  /**
   * 平均封装开销比 = mean(injectedTokens / executionTokens)，即 studio 包装层
   * 相对直连 CLI 的可控增量部分。「总 ≤1.2x」红线对应此比值 ≤ 0.2。
   * 无任何带执行 tokens 的事件 → null（不编造）。
   */
  avgOverheadRatio: number | null;
  /** 开销比红线 = 0.2 */
  overheadBudget: number;
  /** 窗口内 LLM 提取 tokens 合计（knowledge:extraction 事件；单独核算，不计入 2K 注入红线） */
  extractionTokens: number;
  source: 'events' | 'insufficient-data';
  timestamp: string;
}

/** /monitoring/agents PMO 归属聚合的可注入依赖（测试 stub 避免碰真实 ~/.studio/projects） */
export interface MonitoringServiceDeps {
  /** 全量 PMO 项目读取（默认 projectService.list 大页；getAgentSummary 每次调用批量读一次） */
  listProjects?: () => Promise<ProjectData[]>;
}

export interface AgentSummary {
  agents: Array<{
    id: string;
    /** 2026-07：对应 AgentProfile.id，供前端合并 profile 信息（provider 等） */
    roleId: string;
    name: string;
    status: string;
    currentWorkUnitId: string | null;
    startedAt: string;
    lastError: string | null;
    lastErrorAt: string | null;
    /** 2026-07 PMO-flow UX：当前 WU 快照（无 currentWorkUnitId 或 WU 已不存在 → null） */
    currentWorkUnit: AgentCurrentWorkUnit | null;
    /** 2026-07 PMO-flow UX：归属 PMO（2026-08 归因统一后解析链 ①metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）②reqId→Requirement.projectId；解析不到 → null） */
    pmo: AgentPmoSummary | null;
    /** 2026-07 PMO-flow UX：当前 WU 所在频道（无当前 WU → null） */
    channelId: string | null;
  }>;
  summary: {
    total: number;
    idle: number;
    active: number;
    error: number;
    terminated: number;
  };
}

export interface MonitoringStats {
  workunits: {
    total: number;
    unassigned: number;
    active: number;
    in_review: number;
    done: number;
    blocked: number;
    closed: number;
  };
  agents: {
    total: number;
    idle: number;
    active: number;
    terminated: number;
  };
  recent: {
    completedLast24h: number;
    failedLast24h: number;
  };
}

function countByStatus(snapshots: Array<{ status: string; completedAt: string | null; updatedAt: string }>, status: string): number {
  return snapshots.filter(s => s.status === status).length;
}

export class MonitoringService {
  private fileStore: FileStore;
  private knowledge: KnowledgeMetricsSource | null;
  private deps: MonitoringServiceDeps | null;

  constructor(fileStore?: FileStore, knowledge?: KnowledgeMetricsSource, deps?: MonitoringServiceDeps) {
    this.fileStore = fileStore ?? new FileStore();
    this.knowledge = knowledge ?? null;
    this.deps = deps ?? null;
  }

  /** 缺省取生产 knowledgeService 单例（lazy import，避免模块加载期副作用/循环依赖） */
  private async getKnowledge(): Promise<KnowledgeMetricsSource> {
    if (!this.knowledge) {
      const mod = await import('../knowledge/knowledge-service.js');
      this.knowledge = mod.knowledgeService;
    }
    return this.knowledge;
  }

  /** 全量 PMO 项目读取（deps 注入优先；缺省 lazy import 生产单例，理由同 getKnowledge） */
  private async listProjects(): Promise<ProjectData[]> {
    if (this.deps?.listProjects) return this.deps.listProjects();
    const mod = await import('../pmo/project.service.js');
    return mod.projectService.list({ limit: 100000 });
  }

  /**
   * 2026-07 PMO-flow UX（§6-1）：批量加载当前 WU 聚合上下文。
   * #318：实现提取到 current-wu-context.ts（agent-loop 的 instance status_changed 负载同源），
   * 本方法仅注入 fileStore 与 listProjects 委托。
   */
  private async loadCurrentWuContexts(wuIds: string[]): Promise<Map<string, CurrentWuContext>> {
    return loadCurrentWuContexts(this.fileStore, wuIds, () => this.listProjects());
  }

  async getAgentSummary(): Promise<AgentSummary> {
    const states = await this.fileStore.listStates();

    // Sort by startedAt descending
    states.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Fetch role names from FileStore
    const roleIds = [...new Set(states.map(i => i.roleId))];
    const allProfiles = await this.fileStore.listProfiles();
    const profiles = allProfiles.filter(p => roleIds.includes(p.id));
    const roleNameMap = new Map(profiles.map(p => [p.id, p.name]));

    // 2026-07 PMO-flow UX：批量预取当前 WU 聚合上下文（各数据源读一次，内存匹配）
    const wuIds = [...new Set(states.map(i => i.currentWorkUnitId).filter((id): id is string => !!id))];
    const wuContexts = await this.loadCurrentWuContexts(wuIds);

    const agents = states.map(inst => {
      const wuCtx = inst.currentWorkUnitId ? wuContexts.get(inst.currentWorkUnitId) ?? null : null;
      return {
        id: inst.id,
        // 2026-07：暴露 roleId，前端据此与 AgentProfile 合并展示（provider 等）
        roleId: inst.roleId,
        name: roleNameMap.get(inst.roleId) ?? 'unknown',
        status: inst.status,
        currentWorkUnitId: inst.currentWorkUnitId,
        startedAt: inst.startedAt,
        // F2: 启动失败原因（health probe 等）暴露给监控页
        lastError: inst.lastError ?? null,
        lastErrorAt: inst.lastErrorAt ?? null,
        currentWorkUnit: wuCtx?.currentWorkUnit ?? null,
        pmo: wuCtx?.pmo ?? null,
        channelId: wuCtx?.channelId ?? null,
      };
    });

    const summary = {
      total: agents.length,
      idle: agents.filter(a => a.status === 'idle').length,
      active: agents.filter(a => a.status === 'active').length,
      error: agents.filter(a => a.status === 'error').length,
      terminated: agents.filter(a => a.status === 'terminated').length,
    };

    return { agents, summary };
  }

  async getStats(): Promise<MonitoringStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Agent counts from FileStore
    const allStates = await this.fileStore.listStates();
    const totalAgents = allStates.length;
    const idleAgents = allStates.filter(s => s.status === 'idle').length;
    const activeAgents = allStates.filter(s => s.status === 'active').length;
    const terminatedAgents = allStates.filter(s => s.status === 'terminated').length;

    // WorkUnit counts from FileStore
    const snapshots = await this.fileStore.getIndex();

    const totalWorkUnits = snapshots.length;
    const unassigned = countByStatus(snapshots, 'unassigned');
    const active = countByStatus(snapshots, 'active');
    const inReview = countByStatus(snapshots, 'in_review');
    const done = countByStatus(snapshots, 'done');
    const blocked = countByStatus(snapshots, 'blocked');
    const closed = countByStatus(snapshots, 'closed');

    const last24hMs = last24h.getTime();
    const completedLast24h = snapshots.filter(s =>
      s.status === 'done' && s.completedAt && new Date(s.completedAt).getTime() >= last24hMs
    ).length;
    const failedLast24h = snapshots.filter(s =>
      s.status === 'blocked' && new Date(s.updatedAt).getTime() >= last24hMs
    ).length;

    return {
      workunits: { total: totalWorkUnits, unassigned, active, in_review: inReview, done, blocked, closed },
      agents: { total: totalAgents, idle: idleAgents, active: activeAgents, terminated: terminatedAgents },
      recent: { completedLast24h, failedLast24h },
    };
  }

  /**
   * M1: 飞轮指标聚合 — 透传 knowledgeService 实算结果 + proposal 待审数 + 提取活动（30 天）。
   * 不在此重算，保证与 /api/v1/knowledge-service/flywheel|audit 口径一致。
   */
  async getFlywheelStats(opts?: { eventsFile?: string; windowDays?: number }): Promise<FlywheelStats> {
    const knowledge = await this.getKnowledge();
    const [metrics, audit] = await Promise.all([
      knowledge.getFlywheelMetrics(opts),
      knowledge.getAuditReport(opts),
    ]);
    return {
      quality: metrics.quality,
      hitRate: metrics.hitRate,
      improvement: metrics.improvement,
      freshness: metrics.freshness,
      source: metrics.source ?? 'insufficient-data',
      proposalsPendingReview: audit.entries.byMaturity['draft'] ?? 0,
      extraction: {
        count30d: audit.extractionActivity.count,
        totalTokens30d: audit.extractionActivity.totalTokens,
      },
      windowDays: audit.eventCounts.windowDays,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * M2: 封装开销聚合 — 从 studio-events.jsonl 的 workunit:tokens / knowledge:extraction 事件实算。
   * 窗口内无 workunit:tokens 事件 → 显式 0/null + source='insufficient-data'（不编造）。
   */
  async getOverheadStats(opts?: { eventsFile?: string; windowDays?: number }): Promise<OverheadStats> {
    // #342：窗口读（默认 30d，与 aggregateOverheadEvents 窗口口径一致）——窗口外行不 parse，
    // 读成本随窗口行数而非文件总量；文件不存在由读口返 []，其他 IO 错误降级为数据不足。
    const now = Date.now();
    let rows: any[] = [];
    try {
      rows = await readStudioEventsSince({
        file: opts?.eventsFile,
        sinceMs: now - (opts?.windowDays ?? 30) * 86_400_000,
      });
    } catch {
      rows = [];
    }
    return aggregateOverheadEvents(rows, { windowDays: opts?.windowDays, now });
  }
}

/**
 * M2 封装开销聚合（模块级纯函数，供 getOverheadStats 与单测直接调用）。
 *
 * 口径：
 * - 仅统计窗口内（默认 30 天，容忍 1 分钟时钟偏移）的 workunit:tokens 事件；
 *   payload 损坏或 injectedTokens 非数值的行跳过（不计为 0，不编造）。
 * - avgInjectedTokens = mean(injectedTokens)（注入估算，TokenEstimator 口径由写入方执行）。
 * - executionTokens 为 null 的事件（CLI 未回报 usage）计入注入均值，
 *   但不计入 avgExecutionTokens / avgOverheadRatio；executionCoveragePct 反映覆盖率。
 * - avgOverheadRatio = mean(injectedTokens / executionTokens)，仅对 executionTokens > 0 的事件；
 *   这是包装层可控增量部分，红线 0.2（对应「总 ≤1.2x 直连 CLI」）。
 * - extractionTokens = 窗口内 knowledge:extraction 事件 payload.totalTokens 累加（单独核算）。
 */
export function aggregateOverheadEvents(rows: any[], opts?: { windowDays?: number; now?: number }): OverheadStats {
  const windowDays = opts?.windowDays ?? 30;
  const now = opts?.now ?? Date.now();
  const windowStart = now - windowDays * 86400000;

  let injectedSum = 0;
  let executions = 0;
  let executionSum = 0;
  let executionCount = 0;
  let ratioSum = 0;
  let ratioCount = 0;
  let extractionTokens = 0;
  const workUnitIds = new Set<string>();

  for (const row of rows) {
    const type = row?.type;
    if (type !== 'workunit:tokens' && type !== 'knowledge:extraction') continue;
    const tsRaw = row.createdAt ?? row.timestamp;
    const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
    if (!Number.isFinite(ts) || ts < windowStart || ts > now + 60_000) continue;

    let payload: any = {};
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {});
    } catch {
      continue; // payload 损坏的行跳过
    }

    if (type === 'knowledge:extraction') {
      if (typeof payload.totalTokens === 'number' && Number.isFinite(payload.totalTokens)) {
        extractionTokens += payload.totalTokens;
      }
      continue;
    }

    // workunit:tokens
    if (typeof payload.injectedTokens !== 'number' || !Number.isFinite(payload.injectedTokens)) continue;
    executions++;
    injectedSum += payload.injectedTokens;
    if (typeof payload.workUnitId === 'string') workUnitIds.add(payload.workUnitId);
    const exec = payload.executionTokens;
    if (typeof exec === 'number' && Number.isFinite(exec) && exec > 0) {
      executionSum += exec;
      executionCount++;
      ratioSum += payload.injectedTokens / exec;
      ratioCount++;
    }
  }

  const hasData = executions > 0;
  const avgInjected = hasData ? Math.round(injectedSum / executions) : 0;
  return {
    windowDays,
    executions,
    workUnits: workUnitIds.size,
    avgInjectedTokens: avgInjected,
    injectedBudget: INJECTED_TOKEN_BUDGET,
    injectedBudgetUsedPct: Math.round((avgInjected / INJECTED_TOKEN_BUDGET) * 100),
    avgExecutionTokens: executionCount > 0 ? Math.round(executionSum / executionCount) : null,
    executionCoveragePct: hasData ? Math.round((executionCount / executions) * 100) : 0,
    avgOverheadRatio: ratioCount > 0 ? Math.round((ratioSum / ratioCount) * 1000) / 1000 : null,
    overheadBudget: OVERHEAD_RATIO_BUDGET,
    extractionTokens,
    source: hasData ? 'events' : 'insufficient-data',
    timestamp: new Date(now).toISOString(),
  };
}
