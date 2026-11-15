/**
 * distill-runs (#351) — 蒸馏运行记录持久化（runs.jsonl）
 *
 * 自 distill-store.ts 拆出：提案存取归 review-proposal 正本（append-only + 墓碑折叠），
 * 本文件只留蒸馏域自有的运行记录。状态迁移以完整快照追加，读侧按 run id 折叠；
 * legacy executed/failed 行保持可读。时间戳序列仍供 7 天熔断与 GC 计龄（#144）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';

export type DistillRunOutcome =
  | 'triggered'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'retry-after'
  /** legacy runs.jsonl 成功终态；新写入统一使用 succeeded */
  | 'executed';

export interface DistillRun {
  id: string;
  proposalId: string;
  /** 最近一次状态迁移时间；字段名保留 legacy 数据兼容 */
  executedAt: string;
  outcome: DistillRunOutcome;
  signals: { topicTags: string[]; manualCount: number };
  materialIds: string[];
  /** 全部落地产物 id（知识条目 + 分类通道产物），成功且 ≥1 才推进消费基线 */
  productIds: string[];
  /** 模型产出与落地状态的完整恢复清单；在任何产物副作用前持久化 */
  products?: DistillRunProduct[];
  /** #145 产物落地分布：各通道落地产物 id（knowledge 含回落条目） */
  landings?: DistillRunLandings;
  /** legacy 行可能缺失；新执行从 0 开始，进入 running 时递增 */
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: string;
  /** legacy 失败字段；读侧同步归一到 lastError */
  error?: string;
}

export interface DistillRunLandings {
  knowledge: string[];
  skill: string[];
  memory: string[];
}

export interface DistillRunProduct {
  /** 模型产物稳定身份；knowledge 回落同时用作 entry id */
  id: string;
  type: 'knowledge' | 'skill' | 'preference' | 'execution-knowledge';
  title: string;
  content: string;
  tags: string[];
  status: 'pending' | 'durable';
  /** 实际落地桶；分类通道不可用回落 knowledge 后与原始 type 区分 */
  bucket?: keyof DistillRunLandings;
  /** 分类提案/草稿或知识条目的已落地身份 */
  landingId?: string;
}

export class DistillRunsStore {
  constructor(
    private fileStore: FileStore,
    private dataDir: string,
  ) {}

  private runsPath(): string {
    return path.join(this.dataDir, 'runs.jsonl');
  }

  async appendRun(run: DistillRun): Promise<void> {
    await this.fileStore.appendJsonl(this.runsPath(), run);
  }

  /** 每次状态迁移追加完整快照；读侧按 run id 折叠，保留首次出现顺序。 */
  async listRuns(): Promise<DistillRun[]> {
    const rows = await this.fileStore.readJsonl<DistillRun>(this.runsPath());
    const latest = new Map<string, DistillRun>();
    for (const row of rows) {
      latest.set(row.id, {
        ...row,
        attempts: row.attempts ?? (row.outcome === 'triggered' ? 0 : 1),
        lastError: row.lastError ?? row.error,
      });
    }
    return [...latest.values()];
  }

  async getRun(id: string): Promise<DistillRun | null> {
    return (await this.listRuns()).find(run => run.id === id) ?? null;
  }

  /** 上次蒸馏运行时间（任何 outcome，ISO；无记录 → null）。7 天烧钱熔断的输入。 */
  async lastRunAt(): Promise<string | null> {
    return this.latestExecutedAt(() => true);
  }

  /**
   * 上次实际消费原料的运行时间（succeeded/legacy executed 且产物 ≥1；无 → null）。
   * 失败/空产出不推进此基线，原料不被老化作废。
   */
  async lastConsumedAt(): Promise<string | null> {
    return this.latestExecutedAt(run =>
      (run.outcome === 'succeeded' || run.outcome === 'executed') && run.productIds.length > 0,
    );
  }

  private async latestExecutedAt(match: (run: DistillRun) => boolean): Promise<string | null> {
    const runs = await this.listRuns();
    let latest: string | null = null;
    for (const run of runs) {
      if (!match(run)) continue;
      if (!latest || run.executedAt > latest) latest = run.executedAt;
    }
    return latest;
  }
}
