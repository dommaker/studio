/**
 * incident-ledger 单元测试（#602 D5 bootstrap 历史事故台账）。
 *
 * 台账 = ~/.studio/data/evolution/incident-ledger.jsonl（append-only），
 * 条目 { date, kind, ref, summary, source }；Phase 1 只落盘与计数（进 scanned.incidents），
 * 不混入 (b)/(c) 启发式（语义不同源）；Phase 2 违规计数器直接续写同一格式。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import {
  appendIncidents,
  incidentLedgerPath,
  loadIncidentLedger,
  mapCiRunToIncident,
  type IncidentEntry,
} from '../incident-ledger';

let tmpDir: string;
let fileStore: FileStore;

const entry = (patch?: Partial<IncidentEntry>): IncidentEntry => ({
  date: '2026-09-15T02:51:05Z',
  kind: 'ci-red',
  ref: 'run:34922747509',
  summary: 'CI 红：refactor(web) action-center（#533）',
  source: 'bootstrap:2026-09',
  ...patch,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-ledger-test-'));
  fileStore = new FileStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('incident-ledger', () => {
  it('append + load 往返；文件落在 <baseDir>/evolution/incident-ledger.jsonl', async () => {
    expect(incidentLedgerPath(tmpDir)).toBe(path.join(tmpDir, 'evolution', 'incident-ledger.jsonl'));
    await appendIncidents(fileStore, [entry(), entry({ kind: 'incident-commit', ref: 'commit:1b047ccc', summary: '版本戳修复' })]);
    const loaded = await loadIncidentLedger(fileStore);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ kind: 'ci-red', ref: 'run:34922747509' });
  });

  it('dedupe：同 kind+ref 重复 append 跳过', async () => {
    const first = await appendIncidents(fileStore, [entry()]);
    expect(first).toEqual({ appended: 1, skipped: 0 });
    const second = await appendIncidents(fileStore, [entry(), entry({ ref: 'run:999' })]);
    expect(second).toEqual({ appended: 1, skipped: 1 });
    expect(await loadIncidentLedger(fileStore)).toHaveLength(2);
  });

  it('load 空台账 → []（文件不存在不报错）', async () => {
    expect(await loadIncidentLedger(fileStore)).toEqual([]);
  });

  it('mapCiRunToIncident：gh run 记录 → ci-red 条目', () => {
    const e = mapCiRunToIncident({
      databaseId: 34922747509,
      displayTitle: 'refactor(web): action-center 收口（#533）',
      createdAt: '2026-09-15T02:51:05Z',
      headSha: 'fda437101bce73379992e9fa287b4382b4080a13',
    }, 'bootstrap:2026-09');
    expect(e).toEqual({
      date: '2026-09-15T02:51:05Z',
      kind: 'ci-red',
      ref: 'run:34922747509',
      summary: 'CI 红：refactor(web): action-center 收口（#533）（fda4371）',
      source: 'bootstrap:2026-09',
    });
  });
});
