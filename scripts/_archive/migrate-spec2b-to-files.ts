/**
 * migrate-spec2b-to-files.ts — 从 SQLite 导出 14 个表数据到 FileStore 文件
 *
 * Usage:
 *   npx tsx scripts/migrate-spec2b-to-files.ts [--dry-run]
 *
 * Tables migrated:
 *   数据层: AuditLog, StudioEvent, Execution, Notification, Incident,
 *           EnvironmentSnapshot, KRHistory
 *   配置层: Environment, Agent, AgentConfig, AgentConfigVersion, Capability
 *   知识层: Resolution
 *
 * Safety:
 *   - Backs up data.db → data.db.bak before writing
 *   - --dry-run outputs preview without writing
 *   - Idempotent: checks for existing data before writing
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const prisma = new PrismaClient();
const STUDIO_DIR = path.join(os.homedir(), '.studio');
const DRY_RUN = process.argv.includes('--dry-run');

// Target paths
const PATHS = {
  auditLog: path.join(STUDIO_DIR, 'logs', 'audit.jsonl'),
  studioEvent: path.join(STUDIO_DIR, 'logs', 'studio-events.jsonl'),
  executions: path.join(STUDIO_DIR, 'logs', 'executions.jsonl'),
  notifications: path.join(STUDIO_DIR, 'logs', 'notifications.jsonl'),
  incidents: path.join(STUDIO_DIR, 'logs', 'incidents.jsonl'),
  krHistory: path.join(STUDIO_DIR, 'okr', 'kr-history.jsonl'),
  snapshots: path.join(STUDIO_DIR, 'snapshots'),
  environments: path.join(STUDIO_DIR, 'environments.json'),
  agents: path.join(STUDIO_DIR, 'agents'),
  capabilities: path.join(STUDIO_DIR, 'capabilities'),
  knowledge: path.join(STUDIO_DIR, 'knowledge'),
} as const;

// Backward-compat paths (existing files to check/merge)
const LEGACY_PATHS = {
  studioEvent: path.join(STUDIO_DIR, 'events', 'studio.jsonl'),
  incidents: path.join(STUDIO_DIR, 'events', 'incidents.jsonl'),
};

function ensureDir(dir: string) {
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

/** Read existing jsonl lines, dedup by id (keep latest createdAt) */
function dedupJsonl<T extends { id?: string; createdAt?: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = row.id || JSON.stringify(row);
    const existing = map.get(key);
    if (!existing || (row.createdAt && existing.createdAt && row.createdAt > existing.createdAt)) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

/** Read jsonl file, return array. Returns empty array if file missing. */
function readJsonl<T>(filePath: string): T[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l) as T; } catch { return null; }
    }).filter(Boolean) as T[];
  } catch {
    return [];
  }
}

/** Write array as jsonl */
function writeJsonl(filePath: string, rows: any[]) {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would write ${rows.length} rows to ${filePath}`);
    return;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

/** Write JSON file */
function writeJson(filePath: string, data: any) {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would write to ${filePath}`);
    return;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ═══ Migration functions ═══

async function migrateAuditLog() {
  console.log('\n📋 AuditLog...');
  const rows = await prisma.auditLog.findMany();
  const existing = readJsonl<any>(PATHS.auditLog);
  const merged = dedupJsonl([...existing, ...rows]);
  writeJsonl(PATHS.auditLog, merged);
  console.log(`  ${rows.length} rows (${merged.length} after dedup)`);
}

async function migrateStudioEvent() {
  console.log('\n📋 StudioEvent...');
  const rows = await prisma.studioEvent.findMany();
  // Check legacy path for existing data
  const existing = readJsonl<any>(PATHS.studioEvent);
  const legacy = readJsonl<any>(LEGACY_PATHS.studioEvent);
  const merged = dedupJsonl([...legacy, ...existing, ...rows]);
  writeJsonl(PATHS.studioEvent, merged);
  console.log(`  ${rows.length} rows from DB + ${legacy.length} legacy + ${existing.length} current → ${merged.length} after dedup`);
}

async function migrateExecution() {
  console.log('\n📋 Execution...');
  const rows = await prisma.execution.findMany();
  const existing = readJsonl<any>(PATHS.executions);
  const merged = dedupJsonl([...existing, ...rows]);
  writeJsonl(PATHS.executions, merged);
  console.log(`  ${rows.length} rows (${merged.length} after dedup)`);
}

async function migrateNotification() {
  console.log('\n📋 Notification...');
  const rows = await prisma.notification.findMany();
  const existing = readJsonl<any>(PATHS.notifications);
  const merged = dedupJsonl([...existing, ...rows]);
  writeJsonl(PATHS.notifications, merged);
  console.log(`  ${rows.length} rows (${merged.length} after dedup)`);
}

async function migrateIncident() {
  console.log('\n📋 Incident...');
  const rows = await prisma.incident.findMany();
  const legacy = readJsonl<any>(LEGACY_PATHS.incidents);
  const existing = readJsonl<any>(PATHS.incidents);
  const merged = dedupJsonl([...legacy, ...existing, ...rows]);
  writeJsonl(PATHS.incidents, merged);
  console.log(`  ${rows.length} rows from DB + ${legacy.length} legacy + ${existing.length} current → ${merged.length} after dedup`);
}

async function migrateEnvironmentSnapshot() {
  console.log('\n📋 EnvironmentSnapshot...');
  const rows = await prisma.environmentSnapshot.findMany();
  for (const row of rows) {
    const ts = (row.takenAt || row.createdAt).toISOString().replace(/:/g, '').replace(/\.\d+/, '') + 'Z';
    const filePath = path.join(PATHS.snapshots, `${ts}.json`);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(PATHS.snapshots);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(row, null, 2), 'utf-8');
      }
    }
  }
  console.log(`  ${rows.length} snapshots`);
}

async function migrateKRHistory() {
  console.log('\n📋 KRHistory...');
  const rows = await prisma.kRHistory.findMany();
  const existing = readJsonl<any>(PATHS.krHistory);
  const merged = dedupJsonl([...existing, ...rows]);
  writeJsonl(PATHS.krHistory, merged);
  console.log(`  ${rows.length} rows (${merged.length} after dedup)`);
}

async function migrateOKR() {
  console.log('\n📋 OKR...');
  const rows = await prisma.oKR.findMany();
  for (const okr of rows) {
    const meta: Record<string, unknown> = {
      id: okr.id,
      status: okr.status || 'active',
      progress: okr.progress,
      title: okr.title,
      quarter: okr.quarter,
      companyId: okr.companyId,
      createdAt: okr.createdAt?.toISOString(),
      updatedAt: okr.updatedAt?.toISOString(),
    };
    const objectives = typeof okr.objectives === 'string' ? okr.objectives : JSON.stringify(okr.objectives);
    const keyResults = typeof okr.keyResults === 'string' ? okr.keyResults : JSON.stringify(okr.keyResults);
    if (objectives) meta.objectives = objectives;
    if (keyResults) meta.keyResults = keyResults;

    const bodyParts = [okr.title ? `# ${okr.title}` : '# OKR', '', '## Objectives', '', '## Key Results', ''];
    const body = bodyParts.join('\n');

    // Build markdown
    const frontmatterLines = ['---'];
    for (const [k, v] of Object.entries(meta)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') frontmatterLines.push(`${k}: ${v}`);
      else frontmatterLines.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
    }
    frontmatterLines.push('---');

    const content = frontmatterLines.join('\n') + '\n\n' + body;
    const fileName = okr.quarter ? `${okr.quarter}.md` : `${okr.id}.md`;
    const filePath = path.join(STUDIO_DIR, 'okr', fileName);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(path.join(STUDIO_DIR, 'okr'));
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
  console.log(`  ${rows.length} OKRs`);
}

async function migrateEnvironment() {
  console.log('\n📋 Environment...');
  const rows = await prisma.environment.findMany();
  if (DRY_RUN) {
    console.log(`  [dry-run] Would write ${rows.length} environments`);
    return;
  }
  const existing = JSON.parse(fs.readFileSync(PATHS.environments, 'utf-8').catch(() => '[]'));
  const existingNames = new Set(existing.map((e: any) => e.name));
  for (const env of rows) {
    if (!existingNames.has(env.name)) {
      existing.push({ ...env, createdAt: env.createdAt?.toISOString(), updatedAt: env.updatedAt?.toISOString() });
    }
  }
  writeJson(PATHS.environments, existing);
  console.log(`  ${rows.length} environments`);
}

async function migrateAgent() {
  console.log('\n📋 Agent + AgentConfig...');
  const agents = await prisma.agent.findMany();
  const configs = await prisma.agentConfig.findMany();
  const configMap = new Map(configs.map(c => [c.id, c]));

  for (const agent of agents) {
    const config = configs.get(agent.id);
    const agentData: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      model: config?.model || 'claude-sonnet-4-6',
      systemPrompt: config?.systemPrompt || '',
      tools: config?.tools || [],
      environment: config?.environmentId || null,
      capability: agent.capability?.join(',') || '',
      config: {
        temperature: config?.temperature ?? 0.7,
        maxTokens: config?.maxTokens || 4096,
      },
      status: agent.status || 'active',
      createdAt: agent.createdAt?.toISOString(),
      updatedAt: agent.updatedAt?.toISOString(),
    };

    const filePath = path.join(PATHS.agents, `${agent.id}.json`);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(PATHS.agents);
      // Don't overwrite existing
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2), 'utf-8');
      }
    }
  }
  console.log(`  ${agents.length} agents`);
}

async function migrateAgentConfigVersion() {
  console.log('\n📋 AgentConfigVersion...');
  const rows = await prisma.agentConfigVersion.findMany();
  for (const v of rows) {
    const dir = path.join(PATHS.agents, v.agentConfigId);
    const filePath = path.join(dir, 'versions.jsonl');
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(dir);
      const existing = readJsonl<any>(filePath);
      const exists = existing.some((r: any) => r.version === v.version && r.agentConfigId === v.agentConfigId);
      if (!exists) {
        fs.appendFileSync(filePath, JSON.stringify({
          agentConfigId: v.agentConfigId,
          version: v.version,
          snapshot: v.snapshot,
          changedBy: v.changedBy,
          changeReason: v.changeReason,
          createdAt: v.createdAt?.toISOString() || new Date().toISOString(),
        }) + '\n', 'utf-8');
      }
    }
  }
  console.log(`  ${rows.length} versions`);
}

async function migrateCapability() {
  console.log('\n📋 Capability...');
  const rows = await prisma.capability.findMany();
  for (const cap of rows) {
    const filePath = path.join(PATHS.capabilities, `${cap.name}.json`);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(PATHS.capabilities);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({
          id: cap.id,
          name: cap.name,
          type: cap.type,
          description: cap.description,
          cost: cap.cost,
          status: cap.status,
          metadata: cap.metadata,
          ownershipType: cap.ownershipType,
          ownerId: cap.ownerId,
          price: cap.price,
          rating: cap.rating,
          usageCount: cap.usageCount,
          reviewStatus: cap.reviewStatus,
          autoTestStatus: cap.autoTestStatus,
          userApprovalStatus: cap.userApprovalStatus,
          createdAt: cap.createdAt?.toISOString(),
          updatedAt: cap.updatedAt?.toISOString(),
        }, null, 2), 'utf-8');
      }
    }
  }
  console.log(`  ${rows.length} capabilities`);
}

async function migrateResolution() {
  console.log('\n📋 Resolution...');
  const rows = await prisma.resolution.findMany();
  for (const res of rows) {
    const meta: Record<string, unknown> = {
      type: 'resolution',
      pattern: res.pattern,
      errorClass: res.errorClass,
      layer: res.layer,
      title: res.title,
      maturity: res.status,
      verifyCount: res.verifyCount,
      tags: typeof res.tags === 'string' ? JSON.parse(res.tags) : (res.tags || []),
      createdAt: res.createdAt?.toISOString(),
      updatedAt: res.updatedAt?.toISOString(),
    };
    if (res.sourceGoalId) meta.sourceGoalId = res.sourceGoalId;
    if (res.verifiedAt) meta.verifiedAt = res.verifiedAt?.toISOString();

    const body = `# ${res.title}\n\n## Solution\n\n${res.fix}`;
    const frontmatterLines = ['---'];
    for (const [k, v] of Object.entries(meta)) {
      if (v === null || v === undefined) continue;
      if (k === 'tags' && Array.isArray(v)) {
        frontmatterLines.push(`tags: [${v.map((t: string) => `"${t}"`).join(', ')}]`);
      } else if (typeof v === 'number') {
        frontmatterLines.push(`${k}: ${v}`);
      } else {
        frontmatterLines.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
      }
    }
    frontmatterLines.push('---');
    const content = frontmatterLines.join('\n') + '\n\n' + body;

    const filePath = path.join(PATHS.knowledge, `resolution-${res.id}.md`);
    const legacyPath = path.join(os.homedir(), '.studio', 'knowledge', 'resolutions', `resolution-${res.id}.md`);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${filePath}`);
    } else {
      ensureDir(PATHS.knowledge);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content, 'utf-8');
      }
      // Also write to legacy path for backward compat
      try {
        ensureDir(path.dirname(legacyPath));
        if (!fs.existsSync(legacyPath)) {
          fs.writeFileSync(legacyPath, content, 'utf-8');
        }
      } catch {}
    }
  }
  console.log(`  ${rows.length} resolutions`);
}

// ═══ Main ═══

async function main() {
  console.log('Spec 2b Data Migration Script');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Target: ${STUDIO_DIR}`);
  console.log('');

  if (!DRY_RUN) {
    // Backup database
    const dbPath = process.env.DATABASE_URL?.replace('file:', '') || 'prisma/dev.db';
    const dbAbsPath = path.resolve(dbPath);
    if (fs.existsSync(dbAbsPath)) {
      const backup = dbAbsPath + '.bak';
      fs.copyFileSync(dbAbsPath, backup);
      console.log(`✅ Database backed up: ${backup}`);
    }
  }

  await migrateAuditLog();
  await migrateStudioEvent();
  await migrateExecution();
  await migrateNotification();
  await migrateIncident();
  await migrateEnvironmentSnapshot();
  await migrateKRHistory();
  await migrateOKR();
  await migrateEnvironment();
  await migrateAgent();
  await migrateAgentConfigVersion();
  await migrateCapability();
  await migrateResolution();

  console.log(`\n✅ Migration complete (${DRY_RUN ? 'DRY RUN' : 'LIVE'})`);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
