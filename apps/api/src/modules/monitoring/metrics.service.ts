/**
 * D16 监控指标聚合（B5）— 任务流健康 / 入口转化 / 人工干预 / 周期 / 角色 / 工程质量 / Token / 告警。
 *
 * 数据源（全部文件型，无数据库）：
 *   - FileStore workunits/index.json（状态机快照 + metadata）
 *   - FileStore workunits/events.jsonl（created/claimed/completed/blocked/updated 事件）
 *   - 统一事件文件（D18: ~/.studio/logs/studio-events.jsonl；workunit:tokens、monitor:alert）
 *   - 频道 messages.jsonl（authorType=human，经 FileStore.queryAllMessages）
 *
 * 窗口默认 7d（opts.windowDays 可调）；60s 内存缓存防连打。
 * 口径原则：数据不足 → 显式 0 / null + source='insufficient-data'，不编造。
 * 每个指标组带 description（大白话：这个数高了/低了意味着什么）。
 *
 * 工单 30：类型区 → metrics.types.ts，纯函数聚合区 → metrics-aggregate.ts（re-export 保持导出路径兼容）。
 */

import { FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { readStudioEvents } from '../../utils/studio-events.js';
import { buildAssigneeProfileResolver } from '../workunit/assignee-resolver.js';
import { aggregateOverview, DEFAULT_WINDOW_DAYS } from './metrics-aggregate.js';
import type { OverviewMetrics } from './metrics.types.js';

/** D16: 聚合缓存（60s——要扫 index + 多个 jsonl，避免连打） */
const CACHE_TTL_MS = 60_000;

// re-export：保持既有消费方（routes / 测试）从 metrics.service 导入的路径不变
export { aggregateOverview } from './metrics-aggregate.js';
export type { OverviewAggregateInput } from './metrics-aggregate.js';
export type {
  Percentile,
  TaskFlowMetrics,
  IntakeMetrics,
  HumanInterventionMetrics,
  CycleTimeMetrics,
  RoleMetrics,
  QualityMetrics,
  TokenMetrics,
  AlertMetrics,
  EvidenceMetrics,
  OverviewMetrics,
} from './metrics.types.js';

// ─── Service（数据加载 + 60s 缓存）──

export interface OverviewOptions {
  windowDays?: number;
  /** 测试注入：统一事件文件路径（默认 D18 统一文件） */
  eventsFile?: string;
  /** 测试注入：workunits events.jsonl 路径（默认 FileStore 数据目录下） */
  wuEventsFile?: string;
  /** 测试注入时钟（提供时跳过缓存） */
  now?: number;
}

export class MetricsService {
  private fileStore: FileStore;
  private cache = new Map<string, { at: number; data: OverviewMetrics }>();

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  /** 测试/调试用：清空缓存 */
  invalidateCache(): void {
    this.cache.clear();
  }

  private defaultWuEventsFile(): string {
    return studioPath('data', 'workunits', 'events.jsonl');
  }

  async getOverviewMetrics(opts?: OverviewOptions): Promise<OverviewMetrics> {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const now = opts?.now ?? Date.now();
    const cacheKey = `${opts?.eventsFile ?? ''}|${opts?.wuEventsFile ?? ''}|${windowDays}`;
    if (!opts?.now) {
      const hit = this.cache.get(cacheKey);
      if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
    }

    const [snapshots, wuEvents, events, humanMessages, states, profiles] = await Promise.all([
      this.fileStore.getIndex().catch(() => [] as WorkUnitSnapshot[]),
      this.fileStore.readJsonl<WorkUnitEvent>(opts?.wuEventsFile ?? this.defaultWuEventsFile()).catch(() => [] as WorkUnitEvent[]),
      readStudioEvents({ file: opts?.eventsFile }),
      this.fileStore.queryAllMessages({ authorType: 'human' }).catch(() => [] as Array<{ createdAt?: string }>),
      this.fileStore.listStates().catch(() => [] as Array<{ id: string; roleId: string }>),
      this.fileStore.listProfiles().catch(() => [] as Array<{ id: string; name: string }>),
    ]);

    const resolveAssigneeProfile = buildAssigneeProfileResolver({
      states,
      profileIds: new Set(profiles.map(p => p.id)),
    });
    const profileNames = new Map<string, string>();
    for (const p of profiles) if (p?.id) profileNames.set(p.id, p.name);

    const data = aggregateOverview({
      snapshots,
      wuEvents,
      events,
      humanMessages,
      resolveAssigneeProfile,
      profileNames,
      now,
      windowDays,
    });

    if (!opts?.now) this.cache.set(cacheKey, { at: now, data });
    return data;
  }
}
