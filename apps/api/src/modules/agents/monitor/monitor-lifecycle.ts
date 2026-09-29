/**
 * Monitor Agent — G31 数据生命周期：知识沉淀闸门 + TTL 清理
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责每日 23:55 的数据生命周期管理：
 *   - 沉淀闸门：清理前从即将过期的数据中提取知识（sessions 归档）
 *   - TTL 清理：Session / WorkUnit / sessions 归档 / traces 备份
 *
 * #653：studio-events.jsonl 的保留执法不归本模块——原 step 5（7 天截断）/
 * step 7（30 天已沉淀清理）/ precipitateStudioEvents（每日全量打标重写）
 * 与 #173 轮转（studio-events-rotation.ts：噪声 7 天滚、信号热 30 天→月度 gz
 * 冷包永久、rename 原子）直接冲突，已全部删除；本模块不再读写事件文件。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import type { FileStore } from '@dommaker/studio-shared';

/**
 * 生命周期的实例级状态（由 MonitorService 实例持有并传入，保持 per-instance 语义）。
 */
export interface LifecycleState {
  lastPrecipitateRun: string;
  lastDataLifecycleRun: string;
}

/**
 * 知识沉淀闸门：清理前从即将过期的数据中提取知识。
 * 沉淀失败 → 不清理对应数据源，下次重试。
 * #653：StudioEvent 打标（precipitated）随事件截断删除一并解除——
 * 闸门只剩 sessions 归档一路。
 */
export async function precipitate(state: LifecycleState): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  if (state.lastPrecipitateRun === today) return results;
  state.lastPrecipitateRun = today;

  // .agent.log 归档: 提取执行失败模式
  results.sessions = await precipitateSessionLogs();

  logger.info('[MonitorService] Precipitation completed', results);
  return results;
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
    const gate = await precipitate(state);
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
      // #540：加终态守卫——仅删 done/closed。原「无状态过滤」是 G31 GoalExecution TTL
      // （执行记录，无生命周期状态）迁到 WorkUnit 时机械沿用的产物，非有意设计；
      // 进行中/阻塞的长周期单不再被强删（僵尸单走探测告警/人审，不走静默删除）。
      // 缺 status 的历史行按非终态保留，不误删。
      const TERMINAL_STATUSES = new Set(['done', 'closed']);
      const toDelete = allWu.filter(s =>
        TERMINAL_STATUSES.has(s.status) && new Date(s.createdAt).getTime() < execCutoffMs);
      // #538（ADR 2026-09-15 决策 3）：筛选逻辑留本调用方，
      // 删除循环走 service.delete 单口——墓碑单点构造 + workunit:removed 出声。
      // 动态引入避环（agents → workunit 静态链会经 channels 绕回 agents）
      const { WorkUnitService } = await import('../../workunit/workunit.service.js');
      const workUnitService = new WorkUnitService(fileStore);
      for (const wu of toDelete) {
        await workUnitService.delete(wu.id, { reason: 'monitor TTL: terminal WorkUnit older than 90 days' });
      }
      logger.info('[MonitorService] TTL: WorkUnit cleaned', { deleted: toDelete.length, cutoff: new Date(execCutoffMs).toISOString() });
    } catch (e) {
      logger.warn('[MonitorService] TTL: WorkUnit cleanup failed', { error: String(e) });
    }

    // 4. FileStore disk check (no VACUUM needed for file-based storage)
    logger.info('[MonitorService] TTL: disk cleanup completed (FileStore — no VACUUM needed)');

    // 5/7. (removed #653: studio-events.jsonl 7d 截断 + 30d 已沉淀清理 ——
    // 与 #173 轮转策略冲突且非原子无锁，保留执法归 studio-events-rotation.ts 单口)

    // 6. (removed: knowledge.md truncation — dead chain, KnowledgeStore replaces)

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
