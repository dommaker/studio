/**
 * Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理
 *
 * 从 monitor-agent.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责每日 23:55 的数据生命周期管理：
 *   - 沉淀闸门：清理前从即将过期的数据中提取知识，成功后标记 precipitated
 *   - TTL 清理：Session / WorkUnit / studio.jsonl / StudioEvent / sessions 归档 / traces 备份
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import { studioEventsJsonl } from './monitor-alerts.js';

/**
 * 生命周期的实例级状态（由 MonitorAgent 实例持有并传入，保持 per-instance 语义）。
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

  logger.info('[MonitorAgent] Precipitation completed', results);
  return results;
}

/** 从 StudioEvent 提取知识，成功后标记 precipitated */
async function precipitateStudioEvents(fileStore: FileStore): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
    const oldCutoff = new Date(Date.now() - 30 * 24 * 3600_000);

    const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
    const unmarked = allEvents.filter((e: any) =>
      !e.precipitated
      && e.timestamp
      && new Date(e.timestamp).getTime() >= oldCutoff.getTime()
      && new Date(e.timestamp).getTime() < cutoff.getTime()
    );

    if (unmarked.length === 0) {
      logger.info('[MonitorAgent] Precipitate: no unprompted StudioEvents');
      return true;
    }

    // Mark as precipitated in the JSONL file
    const updatedEvents = allEvents.map((e: any) => {
      const isMatch = !e.precipitated
        && e.timestamp
        && new Date(e.timestamp).getTime() >= oldCutoff.getTime()
        && new Date(e.timestamp).getTime() < cutoff.getTime();
      return isMatch ? { ...e, precipitated: true } : e;
    });

    await fs.promises.writeFile(
      studioEventsJsonl(),
      updatedEvents.map((e: any) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    logger.info('[MonitorAgent] Precipitate StudioEvent: marked', { count: unmarked.length });
    return true;
  } catch (e) {
    logger.warn('[MonitorAgent] Precipitate StudioEvent failed', { error: String(e) });
    return false;
  }
}

/** 从 .agent.log 归档提取执行失败模式 */
async function precipitateSessionLogs(): Promise<boolean> {
  try {
    const sessionsDir = path.join(os.homedir(), '.studio', 'sessions');
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

    logger.info('[MonitorAgent] Precipitate sessions: done', { files: files.length });
    return true;
  } catch (e) {
    logger.warn('[MonitorAgent] Precipitate sessions failed', { error: String(e) });
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

    logger.info('[MonitorAgent] Data lifecycle TTL cleanup starting', { date: today });

    // G31: 先沉淀后清理 — 沉淀失败的数据源不清理
    const gate = await precipitate(fileStore, state);
    logger.info('[MonitorAgent] Precipitation gate', gate);

    // 1. 文件存储不设 TTL（JSONL append-only，清理无意义）
    try {
      const channelCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
      logger.info('[MonitorAgent] TTL: ChannelMessage skipped (file storage)', { cutoff: channelCutoff.toISOString() });
    } catch (e) {
      logger.warn('[MonitorAgent] TTL: ChannelMessage skipped with error', { error: String(e) });
    }

    // 1b. Delete expired Session records (FileStore)
    try {
      const sessionsDir = path.join(os.homedir(), '.studio', 'data', 'sessions');
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
      if (deleted > 0) logger.info('[MonitorAgent] TTL: Session cleaned', { deleted });
    } catch (e) {
      logger.warn('[MonitorAgent] TTL: Session cleanup failed', { error: String(e) });
    }

    // 2. Delete WorkUnit older than 90 days (replaces GoalExecution TTL)
    try {
      const execCutoffMs = Date.now() - 90 * 24 * 3600_000;
      const allWu = await fileStore.getIndex();
      const toDelete = allWu.filter(s => new Date(s.createdAt).getTime() < execCutoffMs);
      for (const wu of toDelete) {
        await fileStore.removeSnapshot(wu.id);
      }
      logger.info('[MonitorAgent] TTL: WorkUnit cleaned', { deleted: toDelete.length, cutoff: new Date(execCutoffMs).toISOString() });
    } catch (e) {
      logger.warn('[MonitorAgent] TTL: WorkUnit cleanup failed', { error: String(e) });
    }

    // 4. FileStore disk check (no VACUUM needed for file-based storage)
    logger.info('[MonitorAgent] TTL: disk cleanup completed (FileStore — no VACUUM needed)');

    // 5. Truncate studio.jsonl（统一事件目录）keeping only last 7 days
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
            const ts = entry.timestamp || 0;
            if (ts >= sevenDaysAgo) {
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
        logger.info('[MonitorAgent] TTL: studio.jsonl truncated', { kept: keepLines.length, removed: removedCount });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] TTL: studio.jsonl truncation failed', { error: String(e) });
    }

    // 6. (removed: knowledge.md truncation — dead chain, KnowledgeStore replaces)

    // 7. StudioEvent TTL: 删除已沉淀且 >30d 的事件
    if (gate.studioEvent !== false) {
      try {
        const eventCutoff = new Date(Date.now() - 30 * 24 * 3600_000);
        const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
        const filtered = allEvents.filter((e: any) =>
          !(e.precipitated && e.timestamp && new Date(e.timestamp).getTime() < eventCutoff.getTime())
        );
        await fs.promises.writeFile(
          studioEventsJsonl(),
          filtered.map((e: any) => JSON.stringify(e)).join('\n') + '\n',
          'utf-8',
        );
        const deleted = allEvents.length - filtered.length;
        logger.info('[MonitorAgent] TTL: StudioEvent cleaned', { deleted });
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: StudioEvent cleanup failed', { error: String(e) });
      }
    } else {
      logger.warn('[MonitorAgent] TTL: StudioEvent cleanup skipped (precipitation failed)');
    }

    // 8. sessions 归档 log: 删除 >30d 的文件（需沉淀成功）
    if (gate.sessions !== false) {
      try {
        const sessionsDir = path.join(os.homedir(), '.studio', 'sessions');
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
          logger.info('[MonitorAgent] TTL: sessions cleaned', { deleted, total: files.length });
        }
      } catch (e) {
        logger.warn('[MonitorAgent] TTL: sessions cleanup failed', { error: String(e) });
      }
    } else {
      logger.warn('[MonitorAgent] TTL: sessions cleanup skipped (precipitation failed)');
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
        logger.info('[MonitorAgent] TTL: traces backup cleaned', { deleted, total: files.length });
      }
    } catch (e) {
      logger.warn('[MonitorAgent] TTL: traces cleanup failed', { error: String(e) });
    }

    logger.info('[MonitorAgent] Data lifecycle TTL cleanup completed', { date: today });
  } catch (e: any) {
    logger.warn('[MonitorAgent] Data lifecycle TTL failed', { error: String(e) });
  }
}
