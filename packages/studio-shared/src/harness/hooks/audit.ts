/**
 * Audit Recorder — 决策级审计事件记录
 *
 * L1: recordDecision() 写入 ~/.harness/audit/{date}.jsonl（追加不可变）
 *     + 发布 EventBus 事件，由 API 层异步写入 DB DecisionAudit 表
 * L2/L3 由 Auditor 角色消费。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { eventBus } from '../../event-bus';

export interface AuditEvent {
  eventType: string;
  entityType: string;
  entityId: string;
  companyId?: string;
  projectId?: string;
  summary: string;
  details?: Record<string, unknown>;
  actorRole?: string;
}

const AUDIT_DIR = path.join(os.homedir(), '.harness', 'audit');

function getAuditFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `${date}.jsonl`);
}

function ensureDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

/**
 * 写入审计文件 + 发布 EventBus 事件供 DB 持久化
 */
export function recordDecision(event: AuditEvent): void {
  ensureDir();

  const entry = {
    ...event,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  // 文件存储（L1，追加不可变）
  fs.appendFileSync(getAuditFile(), JSON.stringify(entry) + '\n', 'utf-8');

  // EventBus 事件（异步，DB 持久化由 API 层 audit-subscriber 处理）
  eventBus.publish('events:audit', entry);
}

export function recordDecisions(events: AuditEvent[]): void {
  for (const event of events) {
    recordDecision(event);
  }
}
