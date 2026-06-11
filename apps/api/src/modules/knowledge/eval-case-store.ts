/**
 * EvalCaseStore — File-based CRUD for eval cases
 *
 * Replaces prisma.knowledgeEntry (type='eval_case') with file-system storage.
 * Eval cases persisted to ~/.studio/eval-cases.json.
 *
 * Migration: D-004 Prisma KnowledgeEntry deletion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// ── Types ──

export interface EvalCaseRecord {
  id: string;
  type: 'eval_case';
  level: string;
  content: string;
  triggerCondition?: string | null;
  sourceGoalId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// ── Store ──

const DATA_DIR = path.join(os.homedir(), '.studio');
const INDEX_FILE = path.join(DATA_DIR, 'eval-cases.json');

let cache: EvalCaseRecord[] | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadIndex(): EvalCaseRecord[] {
  if (cache) return cache;
  try {
    if (!fs.existsSync(INDEX_FILE)) {
      cache = [];
      return cache;
    }
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    cache = JSON.parse(raw);
    return cache!;
  } catch {
    cache = [];
    return cache;
  }
}

function saveIndex(records: EvalCaseRecord[]): void {
  ensureDir();
  cache = records;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

export function listEvalCases(filter: { status?: string } = {}): EvalCaseRecord[] {
  const all = loadIndex();
  if (filter.status) {
    return all.filter(r => r.status === filter.status);
  }
  return all;
}

export function createEvalCase(data: {
  content: string;
  triggerCondition?: string;
  sourceGoalId: string;
  status?: string;
}): EvalCaseRecord {
  const all = loadIndex();
  const now = new Date().toISOString();
  const record: EvalCaseRecord = {
    id: randomUUID(),
    type: 'eval_case',
    level: 'agent_knowledge',
    content: data.content,
    triggerCondition: data.triggerCondition ?? null,
    sourceGoalId: data.sourceGoalId,
    status: data.status || 'active',
    createdAt: now,
    updatedAt: now,
  };
  all.push(record);
  saveIndex(all);
  return record;
}

export function updateEvalCase(id: string, data: { status?: string }): EvalCaseRecord | null {
  const all = loadIndex();
  const idx = all.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const record = all[idx];
  if (data.status !== undefined) record.status = data.status;
  record.updatedAt = new Date().toISOString();
  all[idx] = record;
  saveIndex(all);
  return record;
}

export function invalidateEvalCaseCache(): void {
  cache = null;
}
