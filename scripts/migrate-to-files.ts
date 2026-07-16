#!/usr/bin/env tsx
/**
 * Storage Migration — SQLite Prisma → FileStore
 *
 * 一次性脚本：从 Prisma 读取 AN 运行时数据（5 个 model），写入 FileStore 格式。
 * RequirementsDoc 直接从 SDD 文件读取。
 *
 * 运行:
 *   npx tsx scripts/migrate-to-files.ts
 *
 * 注意: 需要在 Prisma schema 仍有这些 model 时运行（Step 9 前）。
 */

import { PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { FileStore, toKebab } from '@dommaker/studio-shared';

// ── DB ──

const prisma = new PrismaClient();
const fileStore = new FileStore();

// ── Main ──

async function migrateAgentProfiles(): Promise<number> {
  try {
    const rows = await prisma.agentProfile.findMany();
    let count = 0;
    for (const row of rows) {
      const existing = await fileStore.getProfile(row.id);
      if (existing) continue; // 幂等
      await fileStore.createProfile({
        id: row.id,
        name: row.name,
        description: row.description,
        channels: row.channels,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
      count++;
    }
    console.log(`[agents] Migrated ${count} profiles`);
    return count;
  } catch {
    console.log('[agents] Table not found, skipping');
    return 0;
  }
}

async function migrateRuntimeInstances(): Promise<number> {
  try {
    const rows = await prisma.runtimeInstance.findMany();
    let count = 0;
    for (const row of rows) {
      const existing = await fileStore.getState(row.roleId);
      if (existing) continue;
      await fileStore.createState(row.roleId, {
        id: row.id,
        roleId: row.roleId,
        sessionId: row.sessionId,
        status: row.status,
        currentWorkUnitId: row.currentWorkUnitId,
        startedAt: row.startedAt.toISOString(),
        terminatedAt: row.terminatedAt?.toISOString() ?? null,
        lastHeartbeat: row.lastHeartbeat?.toISOString() ?? null,
        metadata: row.metadata,
      });
      count++;
    }
    console.log(`[runtimes] Migrated ${count} instances`);
    return count;
  } catch {
    console.log('[runtimes] Table not found, skipping');
    return 0;
  }
}

async function migrateChannels(): Promise<number> {
  try {
    const rows = await prisma.channel.findMany();
    let count = 0;
    for (const row of rows) {
      const existing = await fileStore.getChannel(row.id);
      if (existing) continue;
      await fileStore.createChannel({
        id: row.id,
        name: row.name,
        type: row.type,
        defaultWorkspaceId: row.defaultWorkspaceId ?? null,
        defaultPath: row.defaultPath ?? null,
        discordChannelId: row.discordChannelId ?? null,
        discordWebhookUrl: row.discordWebhookUrl ?? null,
        members: row.members ?? '[]',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
      count++;
    }
    console.log(`[channels] Migrated ${count} channels`);
    return count;
  } catch {
    console.log('[channels] Table not found, skipping');
    return 0;
  }
}

async function migrateChannelMessages(): Promise<number> {
  try {
    const rows = await prisma.channelMessage.findMany({ orderBy: { createdAt: 'asc' } });
    let count = 0;
    for (const row of rows) {
      await fileStore.appendMessage(row.channelId, {
        id: row.id,
        channelId: row.channelId,
        workUnitId: row.workUnitId ?? null,
        authorType: row.authorType,
        agentName: row.agentName ?? null,
        content: row.content,
        replyToId: row.replyToId ?? null,
        meta: row.meta ?? '{}',
        createdAt: row.createdAt.toISOString(),
      });
      count++;
    }
    console.log(`[messages] Migrated ${count} messages`);
    return count;
  } catch {
    console.log('[messages] Table not found, skipping');
    return 0;
  }
}

async function migrateWorkUnits(): Promise<number> {
  try {
    const rows = await prisma.workUnit.findMany({ orderBy: { createdAt: 'asc' } });
    let count = 0;
    for (const row of rows) {
      const snapshot = {
        id: row.id,
        parentId: row.parentId ?? null,
        type: row.type,
        scope: row.scope,
        assigneeId: row.assigneeId ?? null,
        status: row.status,
        failureType: row.failureType ?? null,
        retryCount: row.retryCount,
        timeoutAt: row.timeoutAt?.toISOString() ?? null,
        channelId: row.channelId ?? null,
        projectPath: row.projectPath ?? null,
        metadata: row.metadata ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        claimedAt: row.claimedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
      };
      await fileStore.appendEvent({ type: 'created', wuId: row.id, timestamp: snapshot.createdAt, data: snapshot });
      await fileStore.upsertSnapshot(snapshot);
      count++;
    }
    console.log(`[workunits] Migrated ${count} units`);
    return count;
  } catch {
    console.log('[workunits] Table not found, skipping');
    return 0;
  }
}

// ── 入口 ──

async function main() {
  console.log('===== Storage Migration: SQLite → FileStore =====\n');

  const total =
    (await migrateAgentProfiles()) +
    (await migrateRuntimeInstances()) +
    (await migrateChannels()) +
    (await migrateChannelMessages()) +
    (await migrateWorkUnits());

  console.log(`\n===== Done: ${total} rows migrated =====`);
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
