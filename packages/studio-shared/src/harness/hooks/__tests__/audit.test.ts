/**
 * Audit Recorder 测试
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordDecision, recordDecisions } from '../audit';

const TEST_AUDIT_DIR = path.join(os.homedir(), '.harness', 'audit');

// 备份真实审计目录
function backupDir(): string | null {
  if (!fs.existsSync(TEST_AUDIT_DIR)) return null;
  const backup = TEST_AUDIT_DIR + '.backup';
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
  fs.renameSync(TEST_AUDIT_DIR, backup);
  return backup;
}

function restoreDir(backup: string | null): void {
  if (fs.existsSync(TEST_AUDIT_DIR)) fs.rmSync(TEST_AUDIT_DIR, { recursive: true });
  if (backup && fs.existsSync(backup)) {
    fs.renameSync(backup, TEST_AUDIT_DIR);
  }
}

function readLatestAuditFile(): any[] {
  const files = fs.existsSync(TEST_AUDIT_DIR)
    ? fs.readdirSync(TEST_AUDIT_DIR).filter(f => f.endsWith('.jsonl'))
    : [];
  if (files.length === 0) return [];
  const latest = files.sort().pop()!;
  const content = fs.readFileSync(path.join(TEST_AUDIT_DIR, latest), 'utf-8');
  return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('AuditRecorder', () => {
  let backup: string | null;

  beforeEach(() => {
    backup = backupDir();
  });

  afterEach(() => {
    restoreDir(backup);
  });

  it('recordDecision 写入审计文件', () => {
    recordDecision({
      eventType: 'test.event',
      entityType: 'test',
      entityId: 'test-1',
      summary: 'Test audit event',
      actorRole: 'executor',
    });

    const entries = readLatestAuditFile();
    const found = entries.find(e => e.entityId === 'test-1');

    expect(found).toBeDefined();
    expect(found!.eventType).toBe('test.event');
    expect(found!.entityId).toBe('test-1');
    expect(found!.summary).toBe('Test audit event');
    expect(found!.actorRole).toBe('executor');
    expect(found!.id).toBeDefined();
    expect(found!.timestamp).toBeDefined();
  });

  it('recordDecisions 批量写入', () => {
    recordDecisions([
      { eventType: 'batch.1', entityType: 'batch', entityId: 'b-1', summary: 'Batch 1' },
      { eventType: 'batch.2', entityType: 'batch', entityId: 'b-2', summary: 'Batch 2' },
      { eventType: 'batch.3', entityType: 'batch', entityId: 'b-3', summary: 'Batch 3' },
    ]);

    const entries = readLatestAuditFile();
    const batchEntries = entries.filter(e => e.entityType === 'batch');

    expect(batchEntries).toHaveLength(3);
    expect(batchEntries.map((e: any) => e.summary)).toEqual(['Batch 1', 'Batch 2', 'Batch 3']);
  });

  it('审计文件为追加模式', () => {
    recordDecision({
      eventType: 'append.1', entityType: 'append', entityId: 'a-1', summary: 'First',
    });
    const afterFirst = readLatestAuditFile().length;

    recordDecision({
      eventType: 'append.2', entityType: 'append', entityId: 'a-2', summary: 'Second',
    });
    const afterSecond = readLatestAuditFile().length;

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it('审计文件在 ~/.harness/audit/ 下（绝对路径）', () => {
    recordDecision({
      eventType: 'path.test', entityType: 'path', entityId: 'p-1', summary: 'Path test',
    });

    expect(fs.existsSync(TEST_AUDIT_DIR)).toBe(true);
    const files = fs.readdirSync(TEST_AUDIT_DIR).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('details 字段正确序列化', () => {
    recordDecision({
      eventType: 'detail.test',
      entityType: 'detail',
      entityId: 'd-1',
      summary: 'Detail test',
      details: { count: 5, stepCount: 3, tags: ['auth', 'jwt'] },
    });

    const entries = readLatestAuditFile();
    const found = entries.find((e: any) => e.entityId === 'd-1');

    expect(found!.details).toEqual({ count: 5, stepCount: 3, tags: ['auth', 'jwt'] });
  });
});
