/**
 * #632 合并目标判定（自 message-routing.ts 拆出，#688）——合并窗口 + 歧义守卫。
 *
 * 发送前预览端点（GET /channels/:id/merge-target）与 routeMessage 共用本判定，
 * 保证「预览所见 = 实际路由」。
 */
import { type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/index.js';
import { parseWuMetadata } from '../workunit/index.js';

/**
 * #495（方案 a，票内预授权 2026-09-11）：合并窗口内在途状态——终态（done/closed）
 * 与 in_review（等人工验收）不吸收新消息。
 */
const MERGE_IN_FLIGHT_STATUSES = new Set(['pending', 'unassigned', 'active', 'blocked']);

/**
 * #495：合并窗口（毫秒）。窗口内同频道连续无 @ 消息合并进在途 WU 线程
 * （继续对话 = 继续任务）。默认 5 分钟，
 * STUDIO_CHANNEL_MERGE_WINDOW_MINUTES 覆盖（仿 getReminderThresholdMs 口径）。
 */
export function getMergeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000;
}

/**
 * #632：合并目标判定三态——唯一目标（并入）｜ 歧义（fail-closed 纯存储）｜ 无目标（纯存储）。
 */
export type MergeTargetResolution =
  | { kind: 'unique'; target: { id: string; anchorMessageId?: string } }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * #632（决策已坍缩，自 #495 合并窗口解耦）：合并目标判定——收集窗口内（相对 now）
 * 携带 workUnitId 的人类消息，去重解析出仍在途且属本频道的 WU：
 * 恰好 1 张 → unique（锚点取 WU metadata.anchorMessageId）；≥2 张 → ambiguous
 * （歧义守卫，fail-closed 不并入）；0 张 → none。
 * 锚点为消息时间而非 WU.updatedAt：每次合并落新消息即刷新窗口（滑动窗口语义）。
 * #524 P1-1（#514 定案 D 方案）：尾部倒扫收集 20 条人类消息即停
 * （去重/tombstone 口径与原 queryMessages 一致；不按 createdAt 早停——更新-append
 * 使文件序≠时间序，决议已否决时间早停）。
 */
export async function resolveMergeTarget(
  channelId: string,
  fs: FileStore,
  wuService: WorkUnitService,
  now: Date = new Date(),
): Promise<MergeTargetResolution> {
  const { messages: recentHuman } = await fs.readMessagesTail(channelId, {
    limit: 20,
    match: m => m.authorType === 'human',
  });
  const windowMs = getMergeWindowMs();
  const candidateIds: string[] = [];
  for (const m of recentHuman) { // 倒扫序 = 新→旧
    if (!m.workUnitId || candidateIds.includes(m.workUnitId)) continue;
    if (now.getTime() - new Date(m.createdAt).getTime() > windowMs) continue; // 窗口外不参与
    candidateIds.push(m.workUnitId);
  }
  const inFlight: Array<{ id: string; anchorMessageId?: string }> = [];
  // 2026-09 性能治理：候选 WU 点查并行（Promise.all 保序，倒扫序新→旧不变）
  const candidates = await Promise.all(candidateIds.map(id => wuService.getById(id)));
  for (const wu of candidates) {
    if (!wu || wu.channelId !== channelId) continue;
    if (!MERGE_IN_FLIGHT_STATUSES.has(wu.status)) continue; // 终态/in_review 不构成歧义也不吸收
    // parseWuMetadata 容错口径：畸形 metadata 落 {}（anchorMessageId 缺省走首根回退），不抛错拖垮整道路由
    const meta = parseWuMetadata(wu.metadata);
    inFlight.push({
      id: wu.id,
      anchorMessageId: typeof meta.anchorMessageId === 'string' ? meta.anchorMessageId : undefined,
    });
  }
  if (inFlight.length === 0) return { kind: 'none' };
  if (inFlight.length > 1) return { kind: 'ambiguous' };
  return { kind: 'unique', target: inFlight[0] };
}
