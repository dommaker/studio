#!/usr/bin/env tsx
/**
 * #602 D5：E1 飞轮 bootstrap —— 历史事故台账回填（一次性脚本，可重入）。
 *
 * 数据源（全部真实记录，dry-run 打印逐条供人工核对后才 --apply）：
 *   - CI 红：`gh run list --repo dommaker/studio --status failure --limit 100
 *     --json databaseId,displayTitle,createdAt,headSha > /tmp/ci-red.json`，
 *     经 --runs 传入（gh 调用留在脚本外，脚本可测、可无网络回放）
 *   - 事故 commit：脚本内 INCIDENT_COMMITS 策展清单（issue 点名条目）
 *   - review 打回：当前数据区无持久化留痕（频道未存打回记录），本批次为空；
 *     Phase 2 违规计数器上线后自然积累
 *
 * 幂等：台账按 kind+ref 去重，重复跑只补新条目。
 *
 * Usage:
 *   npx tsx scripts/bootstrap-incident-ledger.ts --runs /tmp/ci-red.json            # dry-run
 *   npx tsx scripts/bootstrap-incident-ledger.ts --runs /tmp/ci-red.json --apply    # 写台账
 *   npx tsx scripts/bootstrap-incident-ledger.ts --root /tmp/fixture                # 指定数据根（测试）
 */
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '../packages/studio-shared/src/index';
import { studioDir } from '../packages/studio-shared/src/config/studio-dir';
import {
  appendIncidents,
  incidentLedgerPath,
  mapCiRunToIncident,
  type CiRunRecord,
  type IncidentEntry,
} from '../apps/api/src/modules/evolution/incident-ledger';

const SOURCE = 'bootstrap:2026-09';

/** issue #602 点名的事故 commit（git log 核实：1b047ccc 2026-09-18 版本戳修复） */
const INCIDENT_COMMITS: IncidentEntry[] = [
  {
    date: '2026-09-18T07:54:29Z',
    kind: 'incident-commit',
    ref: 'commit:1b047ccc',
    summary: '事故修复：fix(harness) 补 .harness/config.yml 版本戳到 1.8.1（issue #602 点名条目）',
    source: SOURCE,
  },
];

export interface BootstrapOptions {
  runsFile?: string;
  root?: string;
  apply?: boolean;
}

export async function runBootstrap(opts: BootstrapOptions): Promise<{ entries: IncidentEntry[]; appended: number; skipped: number }> {
  const entries: IncidentEntry[] = [...INCIDENT_COMMITS];
  if (opts.runsFile) {
    const runs = JSON.parse(fs.readFileSync(opts.runsFile, 'utf-8')) as CiRunRecord[];
    for (const r of runs) entries.push(mapCiRunToIncident(r, SOURCE));
  }
  // 时间升序落盘（台账按事故时间读）
  entries.sort((a, b) => a.date.localeCompare(b.date));

  const dataDir = path.join(opts.root ?? studioDir(), 'data');
  const fileStore = new FileStore(dataDir);
  if (!opts.apply) {
    for (const e of entries) console.log(`[dry-run] ${e.date} ${e.kind} ${e.ref} ${e.summary}`);
    console.log(`[dry-run] 共 ${entries.length} 条；加 --apply 写入 ${incidentLedgerPath(dataDir)}`);
    return { entries, appended: 0, skipped: 0 };
  }
  const { appended, skipped } = await appendIncidents(fileStore, entries);
  console.log(`[apply] appended=${appended} skipped=${skipped} → ${incidentLedgerPath(dataDir)}`);
  return { entries, appended, skipped };
}

/* c8 忽略下一行 —— CLI 入口判定 */
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  runBootstrap({
    runsFile: opt('runs'),
    root: opt('root'),
    apply: args.includes('--apply'),
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
