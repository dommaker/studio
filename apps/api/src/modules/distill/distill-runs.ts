/**
 * distill-runs (#351) — 蒸馏运行记录持久化（runs.jsonl）
 *
 * 自 distill-store.ts 拆出：提案存取归 review-proposal 正本（append-only + 墓碑折叠），
 * 本文件只留蒸馏域自有的运行记录。runs.jsonl 行形态不变（历史不动）：
 * 时间戳/命中信号/原料与产物 id——7 天熔断与 GC 计龄（#144）都依赖这个序列。
 * executed 与 failed 都落记录（failed 也烧了 token，同样触发熔断）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';

export interface DistillRun {
  id: string;
  proposalId: string;
  executedAt: string;
  outcome: 'executed' | 'failed';
  signals: { topicTags: string[]; manualCount: number };
  materialIds: string[];
  /** 全部落地产物 id（知识条目 + 三分通道产物），≥1 即推进消费基线 */
  productIds: string[];
  /** #145 三分落地分布：各通道落地产物 id（knowledge 含回落条目） */
  landings?: DistillRunLandings;
  error?: string;
}

export interface DistillRunLandings {
  knowledge: string[];
  skill: string[];
  constraint: string[];
  memory: string[];
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

  async listRuns(): Promise<DistillRun[]> {
    return this.fileStore.readJsonl<DistillRun>(this.runsPath());
  }

  /** 上次蒸馏运行时间（任何 outcome，ISO；无记录 → null）。7 天烧钱熔断的输入。 */
  async lastRunAt(): Promise<string | null> {
    return this.latestExecutedAt(() => true);
  }

  /**
   * 上次实际消费原料的运行时间（executed 且产物 ≥1；无 → null）。「新条目」基线输入——
   * 失败/空产出不推进此基线，原料不被老化作废。
   */
  async lastConsumedAt(): Promise<string | null> {
    return this.latestExecutedAt(run => run.outcome === 'executed' && run.productIds.length > 0);
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
