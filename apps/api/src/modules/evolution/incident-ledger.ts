/**
 * E1 约束进化：历史事故台账（incident ledger，#602 D5 bootstrap）。
 *
 * 落盘 `<dataDir>/evolution/incident-ledger.jsonl`（append-only，与提案同目录）。
 * 条目 = 一条已核实的历史事故（CI 红 / review 打回 / 事故修复 commit），
 * 全部来自真实记录（gh run list / git log / 频道留痕），逐条人工核对后写入——不编数据。
 *
 * Phase 1 定位：飞轮初始计数基底。只落盘 + 进 runScan 的 scanned.incidents 计数，
 * **不混入 (b)/(c) 启发式**（纪律事故与注入失败语义不同源，混入会污染阈值）。
 * Phase 2（违规代理计数器）直接续写同一格式（schema 即为此设计）。
 */
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';

export type IncidentKind = 'ci-red' | 'review-reject' | 'incident-commit';

export interface IncidentEntry {
  /** 事故发生时间（ISO 8601，取真实记录时间，不是回填时间） */
  date: string;
  kind: IncidentKind;
  /** 溯源引用：run:<gh run id> / commit:<sha> / wu:<id> 等 */
  ref: string;
  summary: string;
  /** 回填批次标记，如 'bootstrap:2026-09'；Phase 2 计数器写 'counter:<rule>' */
  source: string;
}

export function incidentLedgerPath(dataDir: string): string {
  return path.join(dataDir, 'evolution', 'incident-ledger.jsonl');
}

/** 读台账（缺失/损坏 → []，保守安静）。 */
export async function loadIncidentLedger(fileStore: FileStore): Promise<IncidentEntry[]> {
  const rows = await fileStore.readJsonl<IncidentEntry>(incidentLedgerPath(fileStore.getDataDir())).catch(() => []);
  return rows.filter(r => r && typeof r.ref === 'string' && typeof r.kind === 'string');
}

/**
 * 追加台账条目（dedupe：同 kind+ref 视为同一事故，跳过）。
 * 返回 { appended, skipped } 供 bootstrap 脚本报告。
 */
export async function appendIncidents(
  fileStore: FileStore,
  entries: IncidentEntry[],
): Promise<{ appended: number; skipped: number }> {
  const existing = await loadIncidentLedger(fileStore);
  const seen = new Set(existing.map(e => `${e.kind}:${e.ref}`));
  let appended = 0;
  let skipped = 0;
  const file = incidentLedgerPath(fileStore.getDataDir());
  for (const e of entries) {
    const key = `${e.kind}:${e.ref}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    await fileStore.appendJsonl(file, e);
    appended++;
  }
  return { appended, skipped };
}

export interface CiRunRecord {
  databaseId: number;
  displayTitle: string;
  createdAt: string;
  headSha?: string;
}

/** gh run list --json 记录 → ci-red 台账条目（纯函数，脚本与测试共用）。 */
export function mapCiRunToIncident(run: CiRunRecord, source: string): IncidentEntry {
  const sha = run.headSha ? `（${run.headSha.slice(0, 7)}）` : '';
  return {
    date: run.createdAt,
    kind: 'ci-red',
    ref: `run:${run.databaseId}`,
    summary: `CI 红：${run.displayTitle}${sha}`,
    source,
  };
}
