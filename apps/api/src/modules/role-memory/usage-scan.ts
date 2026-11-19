/**
 * role-memory-usage-scan — transcript 后验真实使用扫描（#718）。
 *
 * 只扫描 committed rawOutput 中的 topic 正文路径；MEMORY.md 索引注入不算使用。
 * consumer='role-memory-usage' 独立推进 watermark，任何 topic 写回失败都向外抛出，
 * 使本次增量保持未提交，启动 recoverPending 可续扫。
 */
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';
import { getStore } from '../../core/store.js';
import { consumeTranscript, reconcileTranscriptAssignments } from '../transcripts/index.js';
import type { WorkUnitData } from '../workunit/index.js';
import { buildCompletionLearningMetadata } from './completion-extraction.js';
import { roleMemoryStore, type RoleMemoryStore } from './role-memory.js';

export interface UsedMemoryTopic {
  /** 全路径 memory/<roleId>/topics/<slug>.md 带角色；相对 topics/<slug>.md 缺省。 */
  roleId?: string;
  slug: string;
}

const MEMORY_TOPIC_PATH_RE = /\b(?:memory\/([^/\s]+)\/)?topics\/([a-z0-9][a-z0-9-]*)\.md\b/g;

/** 从文本提取 topic 正文路径，按显式角色 + slug 去重并保持出现顺序。 */
export function extractUsedMemoryTopics(text: string): UsedMemoryTopic[] {
  const topics = new Map<string, UsedMemoryTopic>();
  for (const match of text.matchAll(MEMORY_TOPIC_PATH_RE)) {
    const roleId = match[1];
    const slug = match[2];
    const key = `${roleId ?? ''}:${slug}`;
    if (!topics.has(key)) topics.set(key, { ...(roleId ? { roleId } : {}), slug });
  }
  return [...topics.values()];
}

export class RoleMemoryUsageScanner {
  private subscribed = false;

  constructor(
    private readonly fileStore: FileStore = getStore(),
    private readonly memoryStore: RoleMemoryStore = roleMemoryStore,
  ) {}

  /** 订阅真实迁入 done；幂等，fire-and-forget 不阻断收尾订阅链。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData; previousStatus?: string }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done' || payload.previousStatus === 'done') return;
      void this.scan(wu).catch(err =>
        logger.warn('[RoleMemoryUsageScan] scan failed (non-blocking)', { wuId: wu.id, error: String(err) }),
      );
    });
  }

  /** 启动续扫 done WU；单个失败保留其 watermark，不阻断其他任务。 */
  async recoverPending(): Promise<void> {
    const snapshots = await this.fileStore.listCurrentSnapshots();
    for (const snapshot of snapshots.filter(item => item.status === 'done')) {
      await this.scan(snapshot).catch(err =>
        logger.warn('[RoleMemoryUsageScan] recovery failed (non-blocking)', { wuId: snapshot.id, error: String(err) }),
      );
    }
  }

  /** assigneeId → profile id；实例 id 则读 state.roleId（与完成提取同口径）。 */
  private async resolveRoleId(assigneeId: string | null): Promise<string | null> {
    if (!assigneeId) return null;
    if (await this.fileStore.getProfile(assigneeId)) return assigneeId;
    const state = await this.fileStore.getState(assigneeId).catch(() => null);
    return state?.roleId ?? null;
  }

  /** 扫描 committed 增量；全部实际存在的 topic 写回成功后才由 consumeTranscript 推进水位。 */
  async scan(wu: Pick<WorkUnitData, 'id'>): Promise<string[]> {
    const snapshot = (await this.fileStore.getIndex({ id: wu.id }))[0];
    if (snapshot) await reconcileTranscriptAssignments(snapshot);
    const roleId = snapshot ? await this.resolveRoleId(snapshot.assigneeId) : null;
    const learning = snapshot && roleId ? buildCompletionLearningMetadata(snapshot, roleId) : undefined;

    const result = await consumeTranscript(wu.id, 'role-memory-usage', async entries => {
      if (!roleId || !learning) return [];
      const used = new Set<string>();
      const seen = new Set<string>();
      for (const entry of entries) {
        const assignmentId = entry.assignmentId ?? learning.assignmentId ?? 'unknown';
        const stepRecord = [...(snapshot?.stepRecords ?? [])].reverse()
          .find(item => item.assignmentId === assignmentId);
        const verification = stepRecord?.verification?.status
          ?? (assignmentId === learning.assignmentId ? learning.outcome.verification : 'unknown');
        for (const topic of extractUsedMemoryTopics(entry.rawOutput ?? '')) {
          if (topic.roleId && topic.roleId !== roleId) continue;
          const key = `${assignmentId}:${topic.slug}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!await this.memoryStore.readTopic(roleId, topic.slug)) continue;
          try {
            await this.memoryStore.recordUsage(roleId, topic.slug, {
              workUnitId: wu.id,
              assignmentId,
              stepRecordId: stepRecord?.id,
              at: stepRecord?.at ?? entry.createdAt,
              verification,
            });
          } catch (err) {
            logger.warn('[RoleMemoryUsageScan] recordUsage failed', { wuId: wu.id, roleId, slug: topic.slug, error: String(err) });
            throw err;
          }
          used.add(topic.slug);
        }
      }
      const slugs = [...used];
      if (slugs.length > 0) logger.info('[RoleMemoryUsageScan] memory usage recorded', { wuId: wu.id, roleId, topics: slugs });
      return slugs;
    });
    return result.value;
  }
}

let _scanner: RoleMemoryUsageScanner | null = null;

export function initRoleMemoryUsageScan(): RoleMemoryUsageScanner {
  if (!_scanner) _scanner = new RoleMemoryUsageScanner();
  _scanner.subscribeToEvents();
  void _scanner.recoverPending().catch(err =>
    logger.warn('[RoleMemoryUsageScan] startup recovery failed (non-blocking)', { error: String(err) }));
  return _scanner;
}
