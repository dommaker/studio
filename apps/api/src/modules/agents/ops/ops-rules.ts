/**
 * Ops Rules — 运行时数据，不在代码里
 *
 * Ops Agent 启动时加载，Evolution 可以更新。
 * 路径: process.env.OPS_RULES_PATH || ~/.studio/ops-rules.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

export interface OpsRules {
  version: number;
  checks: {
    /** 进程名匹配模式（ps aux grep） */
    processes_to_clean: string[];
    /** 磁盘告警阈值 (百分比) */
    disk_threshold_warn: number;
    /** 磁盘阻断阈值 (百分比) */
    disk_threshold_critical: number;
  };
  patterns: OpsPattern[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface OpsPattern {
  id: string;
  from: string;         // Incident ID
  description: string;
  autoFix: boolean;     // Ops can auto-fix this pattern?
  addedAt: string;
  addedBy: string;
}

const DEFAULT_RULES: OpsRules = {
  version: 1,
  checks: {
    processes_to_clean: ['tsx', 'node.*index', 'cloudflared'],
    disk_threshold_warn: 80,
    disk_threshold_critical: 90,
  },
  patterns: [
    {
      id: 'cloudflared_cleanup',
      from: 'INC-2026-05-21-002',
      description: 'cloudflared tunnel not in port listeners, needs separate cleanup',
      autoFix: true,
      addedAt: '2026-05-21T00:00:00Z',
      addedBy: 'ops-agent',
    },
  ],
};

export function getRulesPath(): string {
  return process.env.OPS_RULES_PATH || studioPath('ops-rules.json');
}

export function loadRules(): OpsRules {
  const rulesPath = getRulesPath();
  try {
    if (fs.existsSync(rulesPath)) {
      const raw = fs.readFileSync(rulesPath, 'utf-8');
      const rules = JSON.parse(raw);
      // Merge with defaults so new fields always exist
      return { ...DEFAULT_RULES, ...rules, checks: { ...DEFAULT_RULES.checks, ...rules.checks } };
    }
  } catch (e: any) {
    logger.warn('[OpsRules] Failed to load, using defaults', { error: String(e) });
  }
  return DEFAULT_RULES;
}

export function saveRules(rules: OpsRules): void {
  const rulesPath = getRulesPath();
  try {
    rules.updatedAt = new Date().toISOString();
    rules.version = (rules.version || 0) + 1;
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
    logger.info('[OpsRules] Saved', { path: rulesPath, version: rules.version });
  } catch (e: any) {
    logger.warn('[OpsRules] Failed to save', { error: String(e) });
  }
}
