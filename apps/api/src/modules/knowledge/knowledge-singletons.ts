/**
 * knowledge-singletons — 知识子系统共享单例的唯一所有者 (R4 收敛, 断点 H)
 *
 * 此前这些单例散落在 @deprecated 的 knowledge-bus.service.ts 中，
 * 导致「已废弃模块持有全部共享状态」的倒挂。本模块接管所有权：
 *   - 统一存储路径 UNIFIED_KNOWLEDGE_DIR（运行时知识库唯一 = ~/.studio/knowledge）
 *   - sharedStore / sharedLifecycle / sharedIngest / sharedQuery / sharedInjector / sharedLinter
 *   - 消费事件链（recordReference → knowledge:consumption 事件）
 *   - scheduleVectorDbSync（向量库同步：flock 单写者 + 700M 内存帽 + 指数退避）
 *   - ingestWithQualityGate — 全系统唯一的 recordPattern 质量门（R4 收敛：
 *     消除 KnowledgeBus ingest gate vs knowledgeService.recordPattern 双路径，
 *     统一走 harness KnowledgeIngest 内置 KnowledgeAudit 门禁）。
 *
 * 本模块只允许依赖 harness / studio-shared / node 内置模块，
 * 不得 import 任何 studio 业务模块（防止循环依赖）。
 */

import { FileKnowledgeStore, KnowledgeIngest, KnowledgeLifecycle, KnowledgeQuery, KnowledgeInjector, KnowledgeLinter, ReferenceTracker } from '@dommaker/harness';
import type { KnowledgeEntry, KnowledgeSubsystem, MaturityLevel } from '@dommaker/harness';
import { FileStore, logger } from '@dommaker/studio-shared';
import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const fileStore = new FileStore();

// KE-002 P0: unified absolute path for knowledge storage
export const UNIFIED_KNOWLEDGE_DIR = studioPath('knowledge');

// local-rag vector-db paths (must match MCP server config)
const LANCE_DB_PATH = path.join(os.homedir(), '.cache', 'mcp-local-rag', 'lancedb');
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
const MODEL_NAME = path.join(MODEL_CACHE_DIR, 'models--onnx-community--bge-small-zh-v1.5-ONNX', 'snapshots', 'main');

// Startup: kill orphan mcp-local-rag ingest processes from previous crashes
try {
  execFileSync('pkill', ['-f', 'mcp-local-rag.*ingest'], { stdio: 'ignore' });
  logger.info('[Knowledge] Cleaned orphan mcp-local-rag ingest processes');
} catch { /* no orphans — good */ }

// Singleton store + lifecycle + ingest — shared by all knowledge consumers
export const sharedStore = new FileKnowledgeStore({ baseDir: UNIFIED_KNOWLEDGE_DIR });
export const sharedLifecycle = new KnowledgeLifecycle(sharedStore, {
  autoPromoteSources: ['triage', 'auditor', 'evolution', 'analyst'],
});
export const sharedIngest = new KnowledgeIngest(sharedStore);
// KE-002 P3: budget-aware query + injector (replaces naive store.list)
// 注意：KnowledgeQuery 仅提供 query/queryByMode/consume 预算查询，
// 注入链路（queryEntries/getIndexes/count/listEntries）请使用
// engine/unified-query.ts 的 UnifiedQuery（见 knowledge-service.ts 单例装配）。
export const sharedQuery = new KnowledgeQuery(sharedStore, sharedLifecycle);
export const sharedInjector = new KnowledgeInjector(sharedQuery);
// GAP-01: shared linter for ingest validation
export const sharedLinter = new KnowledgeLinter(sharedStore, new ReferenceTracker(sharedStore));

// D6 flywheel: emit consumption events on every recordReference() call
// (same-day dedup already handled by lifecycle, so max 1 event per contributor per entry per day)
// Cast needed: onReference added in harness 0.13.4+, npm version may lag
let _consumptionCallbackRegistered = false;
(sharedLifecycle as any).onReference?.((event: { entryId: string; contributor: string; timestamp: string }) => {
  fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
    type: 'knowledge:consumption',
    source: event.contributor,
    payload: JSON.stringify({ entryId: event.entryId, timestamp: event.timestamp }),
    createdAt: new Date().toISOString(),
  }).catch((e: any) => {
    logger.warn('[Knowledge] consumption event failed', { error: String(e) });
  });
});
_consumptionCallbackRegistered = typeof (sharedLifecycle as any).onReference === 'function';
if (!_consumptionCallbackRegistered) {
  logger.error('[Knowledge] onReference callback NOT registered — consumption events will not be emitted. Check harness version (need >=0.13.4)');
}

/**
 * GAP-16: Verify consumption event chain integrity.
 * Call once at startup to confirm recordReference → onReference → StudioEvent works.
 */
export async function verifyConsumptionChain(): Promise<boolean> {
  try {
    if (!_consumptionCallbackRegistered) return false;
    // Write a probe event directly to confirm DB is writable
    const probeId = `probe_${Date.now()}`;
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'knowledge:probe',
      source: 'startup',
      payload: JSON.stringify({ ts: Date.now(), purpose: 'chain-integrity-check' }),
      createdAt: new Date().toISOString(),
    });
    logger.info('[Knowledge] Consumption chain probe OK', { probeId });
    return true;
  } catch (e: any) {
    logger.error('[Knowledge] Consumption chain probe FAILED', { error: String(e) });
    return false;
  }
}

// ── local-rag sync debounce timer + mutex ──
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;
let deferredSince: number | null = null;  // #2: track deferral start for log dedup
let failCount = 0;  // #3: consecutive failure count for backoff

/**
 * 将 .studio/knowledge/ 同步到 local-rag 向量库。
 * 防止知识写盘后 Agent 无法通过 mcp__local-rag__query_documents 检索到新条目。
 *
 * 使用 mcp-local-rag CLI 增量 ingest（已 ingest 的文件自动跳过）。
 * 5s 防抖：批量 ingest 15 条 → 只触发 1 次 sync。
 * 互斥锁：防止并发写入 LanceDB 导致 commit conflict。
 * 失败重试：指数退避（10s, 20s, 40s... cap 120s，最多 10 次）。
 * 日志策略（P4 修订）：锁竞争（空输出）静默重排；真实失败每个 episode 只 warn
 * 一次（带 stderr 尾部 800 字符——错误在尾部），重试走 debug，放弃 error 一次，
 * 恢复 info 一次。
 */
export function isVectorDbSyncing(): boolean {
  return syncInProgress;
}

export function scheduleVectorDbSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (syncInProgress) {
      // #2: only log first defer, not every 5s
      if (!deferredSince) {
        deferredSince = Date.now();
        logger.info('[Knowledge] vector-db sync deferred (previous sync still running)');
      }
      scheduleVectorDbSync();
      return;
    }
    syncInProgress = true;
    // systemd-run scope 给 ingest 加 700M 内存帽（实测峰值 ~475M）：
    // 超帽被 cgroup OOM 杀掉后走下方既有失败重试逻辑，LanceDB 提交原子、不会写坏。
    // flock 保证多实例（systemd / 手动 npm dev / test 实例）同时只有一个写向量库，
    // 锁被占时立即失败走退避重试（增量跳过后胜者很快，不会久等）。
    // 超时 30 分钟：停机积压几百个文件时全量追赶需要 5–15 分钟；平时增量只需几秒。
    const args = [
      '--scope', '-q', '--collect', '-p', 'MemoryMax=700M',
      'flock', '-n', '/tmp/vector-db-sync.lock',
      'nice', '-n', '10', 'mcp-local-rag',
      '--db-path', LANCE_DB_PATH,
      '--cache-dir', MODEL_CACHE_DIR,
      '--model-name', MODEL_NAME,
      'ingest', UNIFIED_KNOWLEDGE_DIR,
      '--base-dir', UNIFIED_KNOWLEDGE_DIR,
    ];
    execFile('systemd-run', args, { timeout: 1_800_000 }, (err, stdout, stderr) => {
      syncInProgress = false;
      // #2: log resume after deferral
      if (deferredSince) {
        const waited = Math.round((Date.now() - deferredSince) / 1000);
        deferredSince = null;
        logger.info('[Knowledge] vector-db sync resumed after deferral', { waitedSec: waited });
      }
      if (err) {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        // optimize() failures are non-fatal (data already inserted)
        if (output.includes('Succeeded:') || (err.message || '').includes('Succeeded:')) {
          const summary = output.match(/Succeeded:\s*\d+.*Failed:\s*\d+.*Total chunks:\s*\d+/s)?.[0];
          logger.info('[Knowledge] vector-db synced (with optimize warning)', { summary });
          failCount = 0;
          return;
        }
        // flock -n 未抢到锁（另一实例 / agent 作用域 sync 在写——journal 实测存在
        // agent-HOME 作用域的同款 sync 共用 /tmp/vector-db-sync.lock）：预期内竞争，
        // 静默按固定节奏重排，不计失败、不告警。空输出即锁竞争（systemd-run 级错误
        // 一定有 stderr；mcp-local-rag 启动即打印 Found N file(s)，不可能空输出）。
        if (output.length === 0) {
          logger.debug('[Knowledge] vector-db sync skipped (lock held by another writer), rescheduled');
          setTimeout(() => scheduleVectorDbSync(), 15_000);
          return;
        }
        // #3: re-schedule with exponential backoff on real failure (cap 10 attempts, 120s backoff)
        // P4 修订：错误原因在输出尾部（原 slice(0,500) 只留头部命令行，journal 永远看不到
        // 真实 stderr）；告警降级为每个失败 episode 只 warn 一次，重试静默（debug），
        // 放弃时 error 一次，恢复时 info 一次 —— 不再每条 attempt 刷 journal。
        failCount++;
        const errorTail = output.length > 800 ? output.slice(-800) : output;
        if (failCount === 1) {
          logger.warn('[Knowledge] vector-db sync failed, backing off (retries silent until give-up/recovery)', {
            attempt: failCount, errorTail,
          });
        } else {
          logger.debug('[Knowledge] vector-db sync retry failed', { attempt: failCount, errorTail });
        }
        if (failCount > 10) {
          logger.error('[Knowledge] vector-db sync gave up after 10 attempts', {
            totalAttempts: failCount, errorTail,
          });
          failCount = 0;
          return;
        }
        const backoffSec = Math.min(10 * Math.pow(2, failCount - 1), 120);
        setTimeout(() => scheduleVectorDbSync(), backoffSec * 1000);
        return;
      }
      if (failCount > 0) {
        logger.info('[Knowledge] vector-db sync recovered', { afterAttempts: failCount });
      }
      failCount = 0;
      // Extract summary line from stdout
      const summary = stdout.match(/Succeeded:\s*\d+.*Failed:\s*\d+.*Total chunks:\s*\d+/s)?.[0] || stdout.slice(-100);
      logger.info('[Knowledge] vector-db synced', { summary });
    });
  }, 5_000);
}

// ── 统一质量门（R4：单一路径） ──

export interface QualityGateIngestInput {
  /** 映射后的知识类型（guideline/pitfall/process/...） */
  type: KnowledgeSubsystem;
  title: string;
  content: string;
  tags: string[];
  /** 生产者来源（monitor/triage/evolution/...），用于 source 归因与 triage 业务门 */
  source: string;
  /** 原始条目类型（pattern/failure/triage/...），用于事件 payload；缺省 = type */
  entryType?: string;
  layer?: 'system' | 'project' | 'tech';
  maturity?: MaturityLevel;
  consumptionMode?: KnowledgeEntry['consumptionMode'];
}

/**
 * 全系统唯一的 recordPattern 质量门（R4 收敛，断点 H）。
 *
 * 门禁顺序：
 *   1. Triage 业务门（studio 规则）：source/entryType 为 triage 的条目必须含
 *      root_cause + fix_action，否则跳过并发 knowledge:quality_gate 事件。
 *   2. Harness ingest 门（被维护方）：KnowledgeIngest.ingestEntry 内置
 *      KnowledgeAudit —— reject 级问题不入库（返回 __rejected 标记），
 *      flag 级问题入库后自动打 low_quality 标签。studio 侧不再另起 linter 预检。
 *   3. 成功入库 → scheduleVectorDbSync + knowledge:entry_created 事件。
 *
 * 返回保存的条目；被任一门禁跳过时返回 null。
 */
export function ingestWithQualityGate(
  deps: { ingest: KnowledgeIngest },
  input: QualityGateIngestInput,
): KnowledgeEntry | null {
  const entryType = input.entryType ?? input.type;
  const tags = input.tags;

  // 1. Triage 业务门
  if (input.source === 'triage' || entryType === 'triage') {
    const content = (input.content || '').toLowerCase();
    if (!content.includes('root_cause') || !content.includes('fix_action')) {
      const msg = 'Triage entry must include root_cause and fix_action';
      logger.warn(`[Knowledge] ${msg}`, { title: input.title });
      appendKnowledgeEvent('knowledge:quality_gate', { skipped: true, reason: msg, entryType });
      return null;
    }
  }

  // 2. Harness ingest 门（KnowledgeAudit：reject → __rejected；flag → low_quality 标签）
  const saved = deps.ingest.ingestEntry(
    { type: input.type, title: input.title, content: input.content, tags },
    {
      source: `pattern:${input.source}`,
      layer: input.layer ?? 'project',
      maturity: input.maturity ?? 'active',
      tags,
      consumptionMode: input.consumptionMode ?? 'signal',
    },
  );

  if ((saved as any)?.__rejected) {
    const reasons: string[] = (saved as any).__rejectReasons || [];
    const reason = reasons.join('; ') || 'rejected by harness ingest audit';
    logger.warn('[Knowledge] Entry rejected by ingest quality gate', { title: input.title, reason });
    appendKnowledgeEvent('knowledge:quality_gate', { skipped: true, reason, entryType });
    return null;
  }

  // 3. 成功：同步向量库 + entry_created 事件
  scheduleVectorDbSync();
  appendKnowledgeEvent('knowledge:entry_created', { entryType, title: input.title });
  return saved;
}

/** 知识事件写入（best-effort，不阻塞主流程）。source 保持 'knowledge-bus' 以兼容既有指标查询。 */
export function appendKnowledgeEvent(type: string, payload: Record<string, unknown>): void {
  fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
    type,
    source: 'knowledge-bus',
    payload: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  }).catch((e: any) => {
    logger.warn(`[Knowledge] ${type} event failed`, { error: String(e) });
  });
}
