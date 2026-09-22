/**
 * bootstrap-incident-ledger 脚本测试（#602 D5）。
 * gh 调用在脚本外：--runs 传 gh run list 的 JSON 文件，fixture 回放即可测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runBootstrap } from '../bootstrap-incident-ledger';
import { incidentLedgerPath } from '../../apps/api/src/modules/evolution/incident-ledger';

let tmpDir: string;
let runsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-ledger-test-'));
  runsFile = path.join(tmpDir, 'ci-red.json');
  fs.writeFileSync(runsFile, JSON.stringify([
    { databaseId: 34922747509, displayTitle: 'refactor(web): action-center 收口（#533）', createdAt: '2026-09-15T02:51:05Z', headSha: 'fda437101bce73379992e9fa287b4382b4080a13' },
    { databaseId: 34424994283, displayTitle: 'Auto Merge', createdAt: '2026-09-10T01:19:17Z', headSha: 'ab6d5c09b2ec8557a17df64643b83bec07796955' },
  ]), 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrap-incident-ledger', () => {
  it('dry-run 不写文件，返回完整候选清单（策展 commit + CI 红）', async () => {
    const { entries, appended } = await runBootstrap({ runsFile, root: tmpDir });
    expect(appended).toBe(0);
    expect(fs.existsSync(incidentLedgerPath(path.join(tmpDir, 'data')))).toBe(false);
    expect(entries.some(e => e.ref === 'commit:1b047ccc')).toBe(true);
    expect(entries.filter(e => e.kind === 'ci-red')).toHaveLength(2);
    // 时间升序
    expect(entries.map(e => e.date)).toEqual([...entries.map(e => e.date)].sort());
  });

  it('--apply 写台账且幂等（重复跑只补新条目）', async () => {
    const first = await runBootstrap({ runsFile, root: tmpDir, apply: true });
    expect(first.appended).toBe(3); // 2 CI 红 + 1 策展 commit
    const ledger = fs.readFileSync(incidentLedgerPath(path.join(tmpDir, 'data')), 'utf-8').trim().split('\n');
    expect(ledger).toHaveLength(3);

    const second = await runBootstrap({ runsFile, root: tmpDir, apply: true });
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(3);
  });
});
