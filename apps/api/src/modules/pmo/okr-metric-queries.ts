// OKR metric 查询层（B8）— 数据源查询基类，由 okr.service.ts 的 OKRService 继承
import { FileStore, parseFrontmatter } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getStudioEventTime } from '../../utils/studio-events.js';

// ─── 路径常量 ───
const STUDIO_DIR = path.join(os.homedir(), '.studio');
export const OKR_DIR = path.join(STUDIO_DIR, 'okr');
export const KR_HISTORY_JSONL = path.join(STUDIO_DIR, 'okr', 'kr-history.jsonl');
export const EXECUTIONS_JSONL = path.join(STUDIO_DIR, 'logs', 'executions.jsonl');
export const STUDIO_EVENTS_JSONL = path.join(STUDIO_DIR, 'logs', 'studio-events.jsonl');
const INCIDENTS_JSONL = path.join(STUDIO_DIR, 'logs', 'incidents.jsonl');
const RESOLUTIONS_DIR = path.join(STUDIO_DIR, 'knowledge', 'resolutions');

/** JSONL 行事件（D18：createdAt 为准，兼容历史顶层 timestamp） */
export interface StudioEventRow {
  type: string;
  timestamp?: string;
  createdAt?: string;
  payload?: string;
}

interface IncidentRow {
  id: string;
  detectedAt?: string;
}

/**
 * OKR metric 查询基类（B8 数据源查询层）
 */
export class OKRMetricQueries {
  protected fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  /** 从 studio 事件 jsonl 中按 type 和时间范围过滤 */
  private async readEvents(type: string, since: Date): Promise<StudioEventRow[]> {
    const rows = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
    return rows.filter(r => r.type === type && getStudioEventTime(r) >= since.getTime());
  }

  /**
   * 检查数据源可用性
   */
  async checkDataSourceHealth(): Promise<Record<string, 'ok' | 'empty'>> {
    const [studioEvents, snapshots] = await Promise.all([
      this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL),
      this.fileStore.getIndex(),
    ]);
    return {
      studio_event: studioEvents.length > 0 ? 'ok' : 'empty',
      execution: snapshots.length > 0 ? 'ok' : 'empty',
    };
  }

  // ── 具体 metric 查询 ──

  /** 执行成功率 */
  protected async queryExecutionSuccessRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const sinceMs = since.getTime();
    const snapshots = await this.fileStore.getIndex();
    const total = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && s.status !== 'unassigned').length;
    const succeeded = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && s.status === 'done').length;

    if (total === 0) return null;
    return Math.round((succeeded / total) * 100);
  }

  /** 审查通过率 */
  protected async queryReviewPassRate(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 86400000);
    const sinceMs = since.getTime();
    const snapshots = await this.fileStore.getIndex();
    const workUnits = snapshots.filter(s => new Date(s.createdAt).getTime() >= sinceMs && ['done', 'closed'].includes(s.status));

    const withReview = workUnits.filter(w => {
      try {
        const md = JSON.parse(w.metadata!);
        return typeof md?.reviewScore === 'number';
      } catch { return false; }
    });

    if (withReview.length === 0) return null;

    const passed = withReview.filter(w => {
      const md = JSON.parse(w.metadata!);
      return md.reviewScore >= 70;
    });

    return Math.round((passed.length / withReview.length) * 100);
  }

  // ── Extended metric queries (registry) ──

  protected async queryKnowledgeEntryCount(_days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const stats = knowledgeService.getStats();
      return stats.total || 0;
    } catch { return null; }
  }

  protected async queryKnowledgeConsumptionHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const injected = events.filter(e => e.type === 'knowledge:injected' && getStudioEventTime(e) >= since.getTime()).length;
      const consumed = events.filter(e => e.type === 'knowledge:consumption' && getStudioEventTime(e) >= since.getTime()).length;
      if (injected === 0) return null;
      return Math.round((consumed / injected) * 100);
    } catch { return null; }
  }

  protected async queryResolutionCount(_days: number): Promise<number | null> {
    try {
      let count = 0;
      try {
        const entries = await fs.promises.readdir(RESOLUTIONS_DIR, { withFileTypes: true });
        count = entries.filter(e => e.isFile() && e.name.endsWith('.md')).length;
      } catch {
        // dir may not exist
      }
      return count;
    } catch { return null; }
  }

  protected async queryResolutionVerifyRate(_days: number): Promise<number | null> {
    try {
      let total = 0;
      let verified = 0;
      try {
        const entries = await fs.promises.readdir(RESOLUTIONS_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          total++;
          try {
            const content = await fs.promises.readFile(path.join(RESOLUTIONS_DIR, entry.name), 'utf-8');
            const parsed = parseFrontmatter(content);
            if (parsed && parsed.meta.maturity === 'verified') verified++;
          } catch { /* skip unreadable */ }
        }
      } catch {
        // dir may not exist
      }
      if (total === 0) return null;
      return Math.round((verified / total) * 100);
    } catch { return null; }
  }

  protected async queryIncidentCount(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const incidents = await this.fileStore.readJsonl<IncidentRow>(INCIDENTS_JSONL);
      return incidents.filter(i => i.detectedAt && new Date(i.detectedAt).getTime() >= since.getTime()).length;
    } catch { return null; }
  }

  protected async queryDeploySuccessRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('deploy.completed', since);
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try {
          const p = JSON.parse(e.payload!);
          return typeof p.success === 'boolean' ? p.success : p.result?.success;
        } catch { return false; }
      }).length;
      return Math.round((success / events.length) * 100);
    } catch { return null; }
  }

  /** T3: deploy_failure_rate — count of deploy.completed where success=false / total */
  protected async queryDeployFailureRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('deploy.completed', since);
      if (events.length === 0) return null;
      const failures = events.filter(e => {
        try {
          const p = JSON.parse(e.payload!);
          const success = typeof p.success === 'boolean' ? p.success : p.result?.success;
          return success === false;
        } catch { return false; }
      }).length;
      return Math.round((failures / events.length) * 100);
    } catch { return null; }
  }

  protected async queryAnalystAccuracy(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('knowledge:analyst_accuracy', since);
      if (events.length === 0) return null;
      const accurate = events.filter(e => {
        try { return JSON.parse(e.payload!).accurate; } catch { return false; }
      }).length;
      return Math.round((accurate / events.length) * 100);
    } catch { return null; }
  }

  protected async queryBehaviorFeedbackRate(_days: number): Promise<number | null> {
    // UserBehaviorProfile table deleted — feedback rate metric unavailable
    return null;
  }

  protected async querySessionDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const sinceMs = since.getTime();
      const snapshots = await this.fileStore.getIndex();
      const execs = snapshots.filter(s =>
        s.status === 'done' && s.claimedAt && s.completedAt && new Date(s.claimedAt).getTime() >= sinceMs
      );
      if (execs.length === 0) return null;
      const totalMs = execs.reduce((sum, e) =>
        sum + (new Date(e.completedAt!).getTime() - new Date(e.claimedAt!).getTime()), 0);
      return Math.round(totalMs / execs.length / 1000 / 60); // minutes
    } catch { return null; }
  }

  // ── Batch A: OKR metricType queries (data source exists) ──

  /** Pipeline O4-KR3: 排队时间 (WorkUnit.createdAt → child.claimedAt) */
  protected async queryQueueDurationAvg(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const sinceMs = since.getTime();
      const snapshots = await this.fileStore.getIndex();
      const childUnits = snapshots.filter(s => s.parentId !== null && new Date(s.createdAt).getTime() >= sinceMs);
      if (childUnits.length === 0) return null;

      const waits: number[] = [];
      for (const w of childUnits) {
        if (w.claimedAt) {
          waits.push(new Date(w.claimedAt).getTime() - new Date(w.createdAt).getTime());
        }
      }
      if (waits.length === 0) return null;
      return Math.round(waits.reduce((s, w) => s + w, 0) / waits.length / 1000 / 60); // minutes
    } catch { return null; }
  }

  /** Knowledge O1-KR1: 质量门通过率 (extractFromExecution success rate) */
  protected async queryKnowledgeQualityGatePassRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('extractFromExecution', since);
      if (events.length === 0) return null;
      const success = events.filter(e => {
        try { return JSON.parse(e.payload!).success; } catch { return false; }
      }).length;
      return Math.round((success / events.length) * 100);
    } catch { return null; }
  }

  /** Knowledge O1-KR3: 内容质量分 */
  protected async queryKnowledgeQualityScore(_days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const metrics = await knowledgeService.getFlywheelMetrics();
      return metrics.quality ?? null;
    } catch { return null; }
  }

  /** Knowledge O2-KR3: 搜索命中率 */
  protected async queryKnowledgeSearchHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const searches = events.filter(e => e.type === 'knowledge:search' && getStudioEventTime(e) >= since.getTime()).length;
      const hits = events.filter(e => e.type === 'knowledge:search_hit' && getStudioEventTime(e) >= since.getTime()).length;
      if (searches === 0) return null;
      return Math.round((hits / searches) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR4: 质量趋势 (current D2 score, trend via KRHistory) */
  protected async queryKnowledgeQualityTrend(days: number): Promise<number | null> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');
      const metrics = await knowledgeService.getFlywheelMetrics();
      return metrics.quality ?? null;
    } catch { return null; }
  }

  // ── Batch B: queries (data source needs wiring) ──

  /** Knowledge O1-KR2: 去重命中率 */
  protected async queryDedupHitRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('knowledge:quality_gate', since);
      if (events.length === 0) return null;
      const skipped = events.filter(e => {
        try { return JSON.parse(e.payload!).skipped; } catch { return false; }
      }).length;
      return Math.round((skipped / events.length) * 100);
    } catch { return null; }
  }

  /** Knowledge O3-KR1: Skill 生成数 */
  protected async querySkillCreated(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      return events.filter(e => e.type === 'knowledge:skill_created' && getStudioEventTime(e) >= since.getTime()).length;
    } catch { return null; }
  }

  /** Knowledge O3-KR3: 知识增速 */
  protected async queryKnowledgeGrowthRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      return events.filter(e => e.type === 'knowledge:entry_created' && getStudioEventTime(e) >= since.getTime()).length;
    } catch { return null; }
  }

  /** Knowledge O2-KR2: 执行改善度 */
  protected async queryExecutionImprovement(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL);
      const filtered = events.filter(e =>
        e.type.startsWith('knowledge:outcome') && getStudioEventTime(e) >= since.getTime()
      );
      if (filtered.length === 0) return null;
      const withKnowledge = filtered.filter(e => {
        try { return JSON.parse(e.payload!).consumedKnowledge?.length > 0; } catch { return false; }
      });
      if (withKnowledge.length === 0) return null;
      const successWithKnowledge = withKnowledge.filter(e => e.type.includes('success')).length;
      return Math.round((successWithKnowledge / withKnowledge.length) * 100);
    } catch { return null; }
  }

  // ── Batch C: queries (need infrastructure) ──

  /** Pipeline O4-KR1: 最大并行数 */
  protected async queryMaxConcurrent(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const events = await this.readEvents('scheduler:parallel', since);
      if (events.length === 0) return null;
      let max = 0;
      for (const e of events) {
        try {
          const p = JSON.parse(e.payload!);
          if (p.concurrent > max) max = p.concurrent;
        } catch { /* skip */ }
      }
      return max || null;
    } catch { return null; }
  }

  /** Pipeline O4-KR2: 冲突率 */
  protected async queryConflictRate(days: number): Promise<number | null> {
    try {
      const since = new Date(Date.now() - days * 86400000);
      const sinceMs = since.getTime();
      const [snapshots, events] = await Promise.all([
        this.fileStore.getIndex(),
        this.fileStore.readJsonl<StudioEventRow>(STUDIO_EVENTS_JSONL),
      ]);
      const conflicts = events.filter(e => e.type === 'scheduler:conflict' && getStudioEventTime(e) >= sinceMs).length;
      const total = snapshots.filter(s => s.parentId !== null && new Date(s.createdAt).getTime() >= sinceMs).length;
      if (total === 0) return null;
      return Math.round((conflicts / total) * 100);
    } catch { return null; }
  }
}
