/**
 * F5 双向沟通：NEED_INPUT 挂起（waiting）WorkUnit 的恢复与超时提醒。
 *
 * - resumeWaitingWorkUnit: 人类在频道线程中回复 → 解除挂起（blocked → active），
 *   回复内容写入 metadata.pendingReplies，由 AgentLoop 下一步注入 prompt。
 *   不依赖已挂载的 AgentLoop —— 无 loop 时同样解除挂起，待 loop 轮询拾取。
 * - scanWaitingForInputReminders: SCHEDULE trigger（workunit-input-reminder）的 handler，
 *   对挂起超过阈值的 WorkUnit 向频道发一次提醒（每次挂起只提醒一次，恢复时重置）。
 */
import { randomUUID } from 'crypto';
import { logger, FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from './workunit.service.js';
import { findAnchorMessage } from '../agents/agent-loop.js';

/** 提醒阈值（毫秒）。默认 30 分钟，可用 STUDIO_INPUT_REMINDER_MINUTES 覆盖 */
export function getReminderThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.STUDIO_INPUT_REMINDER_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

/**
 * 人类回复后恢复挂起的 WorkUnit。
 * 仅当 WorkUnit 处于 blocked 且 metadata.waitingForInput 时生效（区分卡住型 blocked）。
 * 多条回复在恢复前追加拼接（pendingReplies 数组）。
 * @returns true = 已解除挂起
 */
export async function resumeWaitingWorkUnit(
  workUnitId: string,
  replyText: string,
  fs?: FileStore,
): Promise<boolean> {
  const wuService = new WorkUnitService(fs);
  const wu = await wuService.getById(workUnitId);
  if (!wu) return false;

  const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;

  // 已恢复但 loop 尚未消费 pendingReplies 的窗口内，后续回复直接追加拼接
  if (wu.status === 'active' && Array.isArray(metadata.pendingReplies) && metadata.pendingReplies.length > 0) {
    await wuService.update(workUnitId, {
      metadata: { ...metadata, pendingReplies: [...metadata.pendingReplies, replyText] },
    });
    return true;
  }

  if (wu.status !== 'blocked' || !metadata.waitingForInput) return false;

  const pendingReplies = [...(Array.isArray(metadata.pendingReplies) ? metadata.pendingReplies : []), replyText];
  await wuService.update(workUnitId, {
    metadata: {
      ...metadata,
      waitingForInput: false,
      waitingReminded: false, // 重置提醒标记：下次挂起重新计一次
      pendingReplies,
    },
  });
  await wuService.transitionStatus(workUnitId, 'active');

  logger.info('[WaitingInput] WorkUnit resumed by human reply', { workUnitId });
  return true;
}

/**
 * 扫描挂起超时的 WorkUnit 并向频道发提醒（每次挂起仅一条）。
 * @returns 本次发送的提醒数
 */
export async function scanWaitingForInputReminders(fs?: FileStore, now: Date = new Date()): Promise<number> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const thresholdMs = getReminderThresholdMs();

  const blocked = await wuService.list({ status: 'blocked', limit: 1000 });
  let reminded = 0;

  for (const wu of blocked.data) {
    if (!wu.channelId) continue;
    const metadata = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
    if (!metadata.waitingForInput || metadata.waitingReminded) continue;

    const since = metadata.waitingSince ? new Date(metadata.waitingSince) : wu.updatedAt;
    if (now.getTime() - since.getTime() < thresholdMs) continue;

    const title = (metadata.title ?? wu.scope).slice(0, 50);
    const question = (metadata.waitingQuestion ?? '').slice(0, 100);
    const anchor = await findAnchorMessage(wu.id, fileStore);

    const msg: ChannelMessageData = {
      id: randomUUID(),
      channelId: wu.channelId,
      authorType: 'agent',
      agentName: 'Studio',
      content: `任务「${title}」正在等待你的回复：${question}`,
      replyToId: anchor?.id ?? null,
      meta: '{}',
      workUnitId: wu.id,
      createdAt: now.toISOString(),
    };
    await fileStore.appendMessage(wu.channelId, msg);
    await wuService.update(wu.id, { metadata: { ...metadata, waitingReminded: true } });
    reminded++;
  }

  if (reminded > 0) {
    logger.info(`[WaitingInput] Posted ${reminded} waiting-for-input reminder(s)`);
  }
  return reminded;
}
