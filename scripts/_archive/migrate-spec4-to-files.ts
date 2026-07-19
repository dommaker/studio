/**
 * migrate-spec4-to-files.ts — 从 SQLite 导出 Spec 4 数据到 FileStore
 *
 * Usage:
 *   npx tsx scripts/migrate-spec4-to-files.ts [--dry-run]
 *
 * Tables migrated:
 *   User → ~/.studio/users.json
 *   Session → ~/.studio/sessions.jsonl (RefreshToken 合并为 refreshToken 字段)
 *   Workspace → ~/.studio/workspaces/{id}.json
 *   WorkspaceToken → 嵌入 Workspace JSON 的 tokens[]
 *   WorkspaceRuntime → 嵌入 Workspace JSON 的 runtimes[]
 *   WorkspaceRepo → 嵌入 Workspace JSON 的 repos[]
 *   WorkspaceTask → ~/.studio/workspaces/{id}/tasks.jsonl
 *   WorkspaceEvent → ~/.studio/workspaces/{id}/events.jsonl
 *
 * Also merges ~/.studio/workspace.json legacy data.
 *
 * 注意: 此脚本依赖 PrismaClient，必须在 Phase 4 (删除 studio-prisma) 之前执行。
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const prisma = new PrismaClient();
const STUDIO_DIR = path.join(os.homedir(), '.studio');
const DRY_RUN = process.argv.includes('--dry-run');

function ensureDir(dir: string): void {
  if (DRY_RUN) return;
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would write: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function writeJsonl(filePath: string, records: unknown[]): void {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would write ${records.length} lines to: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  fs.writeFileSync(filePath, content, 'utf-8');
}

async function main(): Promise<void> {
  console.log(`\n=== Spec 4 Migration ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // ── 1. User → users.json ──
  console.log('[1/5] User → users.json');
  const users = await prisma.user.findMany();
  console.log(`  DB rows: ${users.length}`);
  const userData = users.map(u => ({
    id: u.id,
    email: u.email,
    passwordHash: (u as any).passwordHash || null,
    name: (u as any).name || null,
    role: (u as any).role || 'User',
    createdAt: u.createdAt?.toISOString(),
    updatedAt: u.updatedAt?.toISOString(),
  }));
  writeJson(path.join(STUDIO_DIR, 'users.json'), userData);

  // ── 2. Session + RefreshToken → sessions.jsonl ──
  console.log('[2/5] Session → sessions.jsonl (RefreshToken merged)');
  const sessions = await prisma.session.findMany({
    include: { refreshTokens: true },
  });
  console.log(`  DB rows: ${sessions.length}`);
  const sessionData = sessions.map(s => ({
    id: s.id,
    userId: s.userId || null,
    token: s.token,
    guestId: (s as any).guestId || null,
    ipAddress: (s as any).ipAddress || null,
    userAgent: (s as any).userAgent || null,
    expiresAt: s.expiresAt?.toISOString(),
    createdAt: s.createdAt?.toISOString(),
    refreshToken: (s as any).refreshTokens?.[0]?.token || null,
  }));
  writeJsonl(path.join(STUDIO_DIR, 'sessions.jsonl'), sessionData);

  // ── 3. Workspace series → workspaces/{id}.json ──
  console.log('[3/5] Workspace → workspaces/');
  const workspaces = await prisma.workspace.findMany({
    include: {
      tokens: true,
      runtimes: true,
      repos: true,
    },
  });
  console.log(`  DB rows: ${workspaces.length}`);

  // Merge legacy workspace.json
  let legacyWorkspaces: any[] = [];
  const legacyPath = path.join(STUDIO_DIR, 'workspace.json');
  if (fs.existsSync(legacyPath)) {
    try {
      legacyWorkspaces = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      if (!Array.isArray(legacyWorkspaces)) legacyWorkspaces = [legacyWorkspaces];
      console.log(`  Legacy workspace.json entries: ${legacyWorkspaces.length}`);
    } catch (e) {
      console.warn(`  Failed to parse workspace.json: ${e}`);
    }
  }

  // Merge legacy entries by name+workspaceRoot
  const mergeKeySet = new Set<string>();
  for (const ws of workspaces) {
    const key = `${ws.name}::${ws.workspaceRoot}`;
    mergeKeySet.add(key);
  }
  for (const lws of legacyWorkspaces) {
    const key = `${lws.name || 'Unknown'}::${lws.workspaceRoot || ''}`;
    if (!mergeKeySet.has(key)) {
      workspaces.push({
        id: `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        name: lws.name || 'Unknown',
        workspaceRoot: lws.workspaceRoot || '/unknown',
        tokenId: null,
        hasDocker: lws.hasDocker || false,
        os: lws.os || null,
        arch: lws.arch || null,
        status: 'offline',
        tokens: [],
        runtimes: [],
        repos: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      mergeKeySet.add(key);
      console.log(`  Merged legacy: ${lws.name}`);
    }
  }

  for (const ws of workspaces) {
    const wsData = {
      id: ws.id,
      name: ws.name,
      tokenId: ws.tokenId || null,
      workspaceRoot: ws.workspaceRoot,
      hasDocker: (ws as any).hasDocker || false,
      os: (ws as any).os || null,
      arch: (ws as any).arch || null,
      status: ws.status || 'offline',
      currentTask: (ws as any).currentTask || null,
      lastHeartbeat: ws.lastHeartbeat?.toISOString() || null,
      tokens: (ws.tokens || []).map((t: any) => ({
        id: t.id,
        tokenHash: t.tokenHash,
        name: t.name,
        permissions: t.permissions,
        revokedAt: t.revokedAt?.toISOString() || null,
        lastUsedAt: null,
        createdAt: t.createdAt?.toISOString() || new Date().toISOString(),
      })),
      runtimes: (ws.runtimes || []).map((r: any) => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        version: r.version || null,
        status: r.status || 'online',
        lastSeenAt: r.lastSeenAt?.toISOString() || null,
        createdAt: r.createdAt?.toISOString() || new Date().toISOString(),
        updatedAt: r.updatedAt?.toISOString() || new Date().toISOString(),
      })),
      repos: (ws.repos || []).map((r: any) => ({
        id: r.id,
        path: r.path,
        name: r.name,
        category: r.category || null,
        description: r.description || null,
        defaultBranch: r.defaultBranch || 'main',
        remoteUrl: r.remoteUrl || null,
        status: r.status || 'active',
        lastSyncedAt: r.lastSyncedAt?.toISOString() || new Date().toISOString(),
        createdAt: r.createdAt?.toISOString() || new Date().toISOString(),
      })),
      createdAt: ws.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: ws.updatedAt?.toISOString() || new Date().toISOString(),
    };
    writeJson(path.join(STUDIO_DIR, 'workspaces', `${ws.id}.json`), wsData);
    console.log(`  Written: workspaces/${ws.id}.json (${ws.name})`);
  }

  // Delete legacy workspace.json after merge
  if (!DRY_RUN && fs.existsSync(legacyPath) && legacyWorkspaces.length > 0) {
    fs.unlinkSync(legacyPath);
    console.log('  Deleted legacy workspace.json');
  } else if (DRY_RUN && fs.existsSync(legacyPath)) {
    console.log('  [DRY-RUN] Would delete legacy workspace.json');
  }

  // ── 4. WorkspaceTask → workspaces/{id}/tasks.jsonl ──
  console.log('[4/5] WorkspaceTask → workspaces/{id}/tasks.jsonl');
  let totalTasks = 0;
  for (const ws of workspaces) {
    const tasks = await prisma.workspaceTask.findMany({ where: { workspaceId: ws.id } });
    if (tasks.length === 0) continue;
    totalTasks += tasks.length;
    const taskData = tasks.map(t => ({
      id: t.id,
      type: (t as any).type || 'sd',
      status: t.status,
      claimToken: (t as any).claimToken || null,
      claimedBy: (t as any).claimedBy || null,
      runtimeId: t.runtimeId || null,
      path: t.path,
      prompt: t.prompt,
      agent: t.agent,
      modelTier: (t as any).modelTier || 'standard',
      parentGoalId: (t as any).parentGoalId || null,
      sessionId: (t as any).sessionId || null,
      workDir: (t as any).workDir || null,
      result: t.result || null,
      error: null,
      completedAt: t.completedAt?.toISOString() || null,
      createdAt: t.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: t.updatedAt?.toISOString() || new Date().toISOString(),
    }));
    writeJsonl(path.join(STUDIO_DIR, 'workspaces', ws.id, 'tasks.jsonl'), taskData);
  }
  console.log(`  Total tasks: ${totalTasks}`);

  // ── 5. WorkspaceEvent → workspaces/{id}/events.jsonl ──
  console.log('[5/5] WorkspaceEvent → workspaces/{id}/events.jsonl');
  let totalEvents = 0;
  for (const ws of workspaces) {
    const events = await prisma.workspaceEvent.findMany({ where: { workspaceId: ws.id } });
    if (events.length === 0) continue;
    totalEvents += events.length;
    const eventData = events.map(e => ({
      id: e.id,
      type: e.type,
      taskId: e.taskId,
      content: e.content,
      metadata: e.metadata || null,
      createdAt: e.createdAt?.toISOString() || new Date().toISOString(),
    }));
    writeJsonl(path.join(STUDIO_DIR, 'workspaces', ws.id, 'events.jsonl'), eventData);
  }
  console.log(`  Total events: ${totalEvents}`);

  // ── Summary ──
  console.log('\n=== Migration Complete ===');
  console.log(`  Users:   ${users.length}`);
  console.log(`  Sessions: ${sessions.length}`);
  console.log(`  Workspaces: ${workspaces.length} (${legacyWorkspaces.length} legacy merged)`);
  console.log(`  Tasks:   ${totalTasks}`);
  console.log(`  Events:  ${totalEvents}`);
  if (DRY_RUN) console.log('\n  (DRY RUN — no files written)');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
