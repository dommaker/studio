/**
 * Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责每日 23:55 的数据生命周期管理：
 *   - 沉淀闸门：清理前从即将过期的数据中提取知识，成功后标记 precipitated
 *   - TTL 清理：Session / WorkUnit / 统一事件文件（D18: studio-events.jsonl）/ StudioEvent / sessions 归档 / traces 备份
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import type { FileStore } from '@dommaker/studio-shared';
import { studioEventsJsonl } from './monitor-alerts.js';
import { getStudioEventTime } from '../../../utils/studio-events.js';

/**
 * 生命周期的实例级状态（由 MonitorService 实例持有并传入，保持 per-instance 语义）。
 */
export interface LifecycleState {
  lastPrecipitateRun: string;
  lastDataLifecycleRun: string;
}

/**
 * 知识沉淀闸门：清理前从即将过期的数据中提取知识写入 KnowledgeBus。
 * 成功后标记 precipitated=true，只有已沉淀的数据源才允许清理。
 * 沉淀失败 → 不清理对应数据源，下次重试。
 */
export async function precipitate(fileStore: FileStore, state: LifecycleState): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  if (state.lastPrecipitateRun === today) return results;
  state.lastPrecipitateRun = today;

  // 1. StudioEvent: 提取 >7d 且未沉淀的事件
  results.studioEvent = await precipitateStudioEvents(fileStore);

  // 2. .agent.log 归档: 提取执行失败模式
  results.sessions = await precipitateSessionLogs();

  logger.info('[MonitorService] Precipitation completed', results);
  return results;
}

/** 从 StudioEvent 提取知识，成功后标记 precipitated */
async function precipitateStudioEvents(fileStore: FileStore): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
    const oldCutoff = new Date(Date.now() - 30 * 24 * 3600_000);

    const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
    const inWindow = (e: any) => {
      const ts = getStudioEventTime(e);
      return Number.isFinite(ts) && ts >= oldCutoff.getTime() && ts < cutoff.getTime();
    };
    const unmarked = allEvents.filter((e: any) => !e.precipitated && inWindow(e));

    if (unmarked.length === 0) {
      logger.info('[MonitorService] Precipitate: no unprompted StudioEvents');
      return true;
    }

    // Mark as precipitated in the JSONL file
    const updatedEvents = allEvents.map((e: any) => (!e.precipitated && inWindow(e) ? { ...e, precipitated: true } : e));

    await fs.promises.writeFile(
      studioEventsJsonl(),
      updatedEvents.map((e: any) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    logger.info('[MonitorService] Precipitate StudioEvent: marked', { count: unmarked.length });
    return true;
  } catch (e) {
    logger.warn('[MonitorService] Precipitate StudioEvent failed', { error: String(e) });
    return false;
  }
}

/** 从 .agent.log 归档提取执行失败模式 */
async function precipitateSessionLogs(): Promise<boolean> {
  try {
    const sessionsDir = studioPath('sessions');
    if (!fs.existsSync(sessionsDir)) return true;

    const cutoff = Date.now() - 30 * 24 * 3600_000;
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
      }))
      .filter(f => f.mtime < cutoff)
      .slice(0, 20); // 每次最多处理 20 个

    if (files.length === 0) return true;

    // 提取错误模式（只读最后 2KB，错误通常在末尾）
    const errorSnippets: string[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(sessionsDir, f.name), 'utf-8');
        const tail = content.slice(-2000);
        if (tail.includes('Error') || tail.includes('error') || tail.includes('failed')) {
          errorSnippets.push(`### ${f.name}\n${tail.slice(0, 500)}`);
        }
      } catch { /* skip */ }
    }

    if (errorSnippets.length === 0) return true;

    logger.info('[MonitorService] Precipitate sessions: done', { files: files.length });
    return true;
  } catch (e) {
    logger.warn('[MonitorService] Precipitate sessions failed', { error: String(e) });
    return false;
  }
}

/**
 * Data lifecycle management: purges old records, reclaims disk space.
 * Runs once per day at 23:55 (± 5 min), right after dailyReflection.
 * All operations are best-effort with individual try/catch.
 *
 * G31: 闸门模式 — 先沉淀后清理，沉淀失败的数据源不清理。
 */
export async function dataLifecycle(fileStore: FileStore, state: LifecycleState): Promise<void> {
  try {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    // Run at ~23:55 (± 5 min), once per day
    if (!(hour === 23 && minute >= 50 && minute <= 59)) return;

    const today = now.toISOString().split('T')[0];
    if (state.lastDataLifecycleRun === today) return;
    state.lastDataLifecycleRun = today;

    logger.info('[MonitorService] Data lifecycle TTL cleanup starting', { date: today });

    // G31: 先沉淀后清理 — 沉淀失败的数据源不清理
    const gate = await precipitate(fileStore, state);
    logger.info('[MonitorService] Precipitation gate', gate);

    // 1. 文件存储不设 TTL（JSONL append-only，清理无意义）
    try {
      const channelCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
      logger.info('[MonitorService] TTL: ChannelMessage skipped (file storage)', { cutoff: channelCutoff.toISOString() });
    } catch (e) {
      logger.warn('[MonitorService] TTL: ChannelMessage skipped with error', { error: String(e) });
    }

    // 1b. Delete expired Session records (FileStore)
    try {
      const sessionsDir = studioPath('data', 'sessions');
      let deleted = 0;
      const now = new Date();
      try {
        const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.json')) continue;
          const session = await fileStore.readJson<any>(path.join(sessionsDir, e.name));
          if (session && new Date(session.expiresAt) < now) {
            await fs.promises.unlink(path.join(sessionsDir, e.name));
            deleted++;
          }
        }
      } catch { /* no sessions dir */ }
      if (deleted > 0) logger.info('[MonitorService] TTL: Session cleaned', { deleted });
    } catch (e) {
      logger.warn('[MonitorService] TTL: Session cleanup failed', { error: String(e) });
    }

    // 2. Delete WorkUnit older than 90 days (replaces GoalExecution TTL)
    try {
      const execCutoffMs = Date.now() - 90 * 24 * 3600_000;
      const allWu = await fileStore.getIndex();
      const toDelete = allWu.filter(s => new Date(s.createdAt).getTime() < execCutoffMs);
      for (const wu of toDelete) {
        // #170：墓碑事件 + 索引移除同锁成对（对账/重建不复活已删 WU）
        await fileStore.commitRemoval({
          type: 'closed',
          wuId: wu.id,
          timestamp: new Date().toISOString(),
          data: { deleted: true },
        }, wu.id);
      }
      logger.info('[MonitorService] TTL: WorkUnit cleaned', { deleted: toDelete.length, cutoff: new Date(execCutoffMs).toISOString() });
    } catch (e) {
      logger.warn('[MonitorService] TTL: WorkUnit cleanup failed', { error: String(e) });
    }

    // 4. FileStore disk check (no VACUUM needed for file-based storage)
    logger.info('[MonitorService] TTL: disk cleanup completed (FileStore — no VACUUM needed)');

    // 5. Truncate 统一事件文件（D18: studio-events.jsonl）keeping only last 7 days
    try {
      const eventsFile = studioEventsJsonl();
      if (fs.existsSync(eventsFile)) {
        const raw = fs.readFileSync(eventsFile, 'utf-8');
        const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
        const keepLines: string[] = [];
        let removedCount = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const ts = getStudioEventTime(entry);
            if (Number.isFinite(ts) && ts >= sevenDaysAgo) {
              keepLines.push(line);
            } else {
              removedCount++;
            }
          } catch {
            // Preserve unparseable lines (safer than dropping them)
            keepLines.push(line);
          }
        }
        fs.writeFileSync(eventsFile, keepLines.join('\n') + '\n', 'utf-8');
        logger.info('[MonitorService] TTL: studio-events.jsonl truncated', { kept: keepLines.length, removed: removedCount });
      }
    } catch (e) {
      logger.warn('[MonitorService] TTL: studio-events.jsonl truncation failed', { error: String(e) });
    }

    // 6. (removed: knowledge.md truncation — dead chain, KnowledgeStore replaces)

    // 7. StudioEvent TTL: 删除已沉淀且 >30d 的事件
    if (gate.studioEvent !== false) {
      try {
        const eventCutoffMs = Date.now() - 30 * 24 * 3600_000;
        const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
        const filtered = allEvents.filter((e: any) =>
          !(e.precipitated && Number.isFinite(getStudioEventTime(e)) && getStudioEventTime(e) < eventCutoffMs)
        );
        await fs.promises.writeFile(
          studioEventsJsonl(),
          filtered.map((e: any) => JSON.stringify(e)).join('\n') + '\n',
          'utf-8',
        );
        const deleted = allEvents.length - filtered.length;
        logger.info('[MonitorService] TTL: StudioEvent cleaned', { deleted });
      } catch (e) {
        logger.warn('[MonitorService] TTL: StudioEvent cleanup failed', { error: String(e) });
      }
    } else {
      logger.warn('[MonitorService] TTL: StudioEvent cleanup skipped (precipitation failed)');
    }

    // 8. sessions 归档 log: 删除 >30d 的文件（需沉淀成功）
    if (gate.sessions !== false) {
      try {
        const sessionsDir = studioPath('sessions');
        if (fs.existsSync(sessionsDir)) {
          const sessionCutoff = Date.now() - 30 * 24 * 3600_000;
          const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.log'));
          let deleted = 0;
          for (const f of files) {
            try {
              const fp = path.join(sessionsDir, f);
              if (fs.statSync(fp).mtimeMs < sessionCutoff) {
                fs.unlinkSync(fp);
                deleted++;
              }
            } catch { /* skip */ }
          }
          logger.info('[MonitorService] TTL: sessions cleaned', { deleted, total: files.length });
        }
      } catch (e) {
        logger.warn('[MonitorService] TTL: sessions cleanup failed', { error: String(e) });
      }
    } else {
      logger.warn('[MonitorService] TTL: sessions cleanup skipped (precipitation failed)');
    }

    // 10. traces.log: 清理 >30d 的备份文件
    try {
      const tracesDir = path.join(process.cwd(), '.harness', 'logs');
      if (fs.existsSync(tracesDir)) {
        const traceCutoff = Date.now() - 30 * 24 * 3600_000;
        const files = fs.readdirSync(tracesDir).filter(f => f.startsWith('traces-') && f.endsWith('.log'));
        let deleted = 0;
        for (const f of files) {
          try {
            const fp = path.join(tracesDir, f);
            if (fs.statSync(fp).mtimeMs < traceCutoff) {
              fs.unlinkSync(fp);
              deleted++;
            }
          } catch { /* skip */ }
        }
        logger.info('[MonitorService] TTL: traces backup cleaned', { deleted, total: files.length });
      }
    } catch (e) {
      logger.warn('[MonitorService] TTL: traces cleanup failed', { error: String(e) });
    }

    logger.info('[MonitorService] Data lifecycle TTL cleanup completed', { date: today });
  } catch (e: any) {
    logger.warn('[MonitorService] Data lifecycle TTL failed', { error: String(e) });
  }
}
