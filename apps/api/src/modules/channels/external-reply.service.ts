import { randomUUID } from 'node:crypto';
import { FileStore, type EffectRecord } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';
import { EffectService, workUnitPort } from '../workunit/index.js';
import { ChannelMessageService, shapeMessageData, type MessageMeta, type MessageRecord } from './channel-message.service.js';

export interface ExternalReplyInput {
  channelId: string;
  agentName: string;
  content: string;
  workUnitId: string;
  replyToId?: string;
  meta?: MessageMeta;
}

interface ExternalReplyPayload extends ExternalReplyInput, Record<string, unknown> {
  messageId: string;
}

function payloadOf(effect: EffectRecord): ExternalReplyPayload {
  const payload = effect.payload;
  if (!payload || typeof payload.messageId !== 'string' || typeof payload.channelId !== 'string'
    || typeof payload.agentName !== 'string' || typeof payload.content !== 'string'
    || typeof payload.workUnitId !== 'string') {
    throw new Error(`Invalid external-reply payload: ${effect.id}`);
  }
  return payload as ExternalReplyPayload;
}

/** WU 外部回复的持久执行 adapter；消息 id 在意图提交前固定。 */
export class ExternalReplyService {
  private readonly effects: EffectService;
  private readonly messages: ChannelMessageService;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly fileStore: FileStore) {
    this.effects = new EffectService(fileStore);
    this.messages = new ChannelMessageService(fileStore);
  }

  private async deliver(effect: EffectRecord): Promise<{ message: MessageRecord; result: Record<string, unknown> }> {
    const payload = payloadOf(effect);
    const existing = await this.fileStore.getMessageById(payload.messageId, payload.channelId);
    if (existing) {
      return {
        message: shapeMessageData(existing.message),
        result: { messageId: payload.messageId, duplicatePrevented: true },
      };
    }
    const message = await this.messages.createAgentMessage(payload.channelId, payload.agentName, payload.content, {
      messageId: payload.messageId,
      replyToId: payload.replyToId,
      meta: payload.meta,
      workUnitId: payload.workUnitId,
    });
    return { message, result: { messageId: payload.messageId } };
  }

  private async alertPermanentFailure(effect: EffectRecord): Promise<void> {
    try {
      (await workUnitPort('alert')).dispatch([{
        source: 'external_reply_permanent_failure',
        level: 'critical',
        subject: effect.id,
        relatedTaskIds: [effect.workUnitId],
        message: `外部回复 Effect ${effect.id} 已连续 ${effect.attempts} 次失败并停止重试，请人工介入；${effect.lastError ?? ''}`,
      }]);
    } catch { /* 告警失败不覆盖 Effect 的原始结果 */ }
  }

  private scheduleRetry(effect: EffectRecord): void {
    if (effect.status !== 'queued') return;
    const previous = this.retryTimers.get(effect.id);
    if (previous) clearTimeout(previous);
    const delay = Math.max(0, effect.nextAttemptAt ? Date.parse(effect.nextAttemptAt) - Date.now() : 0);
    const timer = setTimeout(() => {
      this.retryTimers.delete(effect.id);
      void this.effects.execute(effect.workUnitId, effect.id, async ({ effect: current }) =>
        (await this.deliver(current)).result
      ).then(async executed => {
        if (executed?.status === 'queued') this.scheduleRetry(executed);
        if (executed?.status === 'failed') await this.alertPermanentFailure(executed);
      }).catch(error => logger.warn('[ExternalReply] Scheduled retry failed', {
        effectId: effect.id, error: String(error),
      }));
    }, delay);
    timer.unref();
    this.retryTimers.set(effect.id, timer);
  }

  async post(input: ExternalReplyInput): Promise<MessageRecord> {
    const messageId = randomUUID();
    const effect = await this.effects.enqueue(input.workUnitId, {
      kind: 'external-reply',
      idempotencyKey: `external-reply:${input.workUnitId}:${messageId}`,
      trigger: 'automatic',
      payload: { ...input, messageId },
    });
    let delivered: MessageRecord | undefined;
    const executed = await this.effects.execute(input.workUnitId, effect.id, async ({ effect: current }) => {
      const delivery = await this.deliver(current);
      delivered = delivery.message;
      return delivery.result;
    });
    if (executed?.status === 'queued') this.scheduleRetry(executed);
    if (executed?.status === 'failed') await this.alertPermanentFailure(executed);
    if (executed?.status !== 'succeeded') {
      throw new Error(executed?.lastError ?? 'External reply effect did not complete');
    }
    if (delivered) return delivered;
    const stored = await this.fileStore.getMessageById(messageId, input.channelId);
    if (!stored) throw new Error(`External reply message missing after Effect success: ${messageId}`);
    return shapeMessageData(stored.message);
  }

  async recover() {
    const before = await this.fileStore.getIndex();
    const result = await this.effects.recover(async ({ workUnit, effect, recovery }) => {
      if (recovery && workUnit.mandate?.revokedAt) {
        const payload = payloadOf(effect);
        const existing = await this.fileStore.getMessageById(payload.messageId, payload.channelId);
        if (!existing) throw new Error('外部回复结果不确定，Mandate 已撤销，需人工核查');
        return { messageId: payload.messageId, duplicatePrevented: true };
      }
      return (await this.deliver(effect)).result;
    }, {
      include: (_snapshot, effect) => effect.kind === 'external-reply',
      reconcileRevoked: true,
    });
    const after = await this.fileStore.getIndex();
    for (const snapshot of after) {
      const previous = before.find(item => item.id === snapshot.id);
      for (const effect of snapshot.effects ?? []) {
        if (effect.kind !== 'external-reply') continue;
        if (effect.status === 'queued') this.scheduleRetry(effect);
        if (effect.status === 'failed'
          && previous?.effects?.find(item => item.id === effect.id)?.status !== 'failed') {
          await this.alertPermanentFailure(effect);
        }
      }
    }
    return result;
  }
}

const externalReplyServices = new WeakMap<FileStore, ExternalReplyService>();

/** 同一 FileStore 共用 EffectService.inFlight，周期恢复不得与正常发送并发执行。 */
export function getExternalReplyService(fileStore: FileStore): ExternalReplyService {
  let service = externalReplyServices.get(fileStore);
  if (!service) {
    service = new ExternalReplyService(fileStore);
    externalReplyServices.set(fileStore, service);
  }
  return service;
}

export async function recoverExternalReplies(fileStore: FileStore) {
  return getExternalReplyService(fileStore).recover();
}
