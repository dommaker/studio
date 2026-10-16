import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { handleDelegateBranch } from '../delegate-branch.js';
import type { StepResult } from '../agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';
import { logger } from '@dommaker/studio-shared/node';

export interface ResultReplyInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  result: StepResult;
  guardUpdates: Partial<WorkUnitMetadata>;
}

export interface ResultReplyResolution {
  action: StepResult['action'];
  skipResultPost: boolean;
  freshnessUpdates: Partial<WorkUnitMetadata>;
}

/** A2A DELEGATE 与 §4.2 新鲜度：确定结果回帖形态及暂存回复。 */
export async function prepareResultReply(
  input: ResultReplyInput,
  host: AgentLoopHost,
): Promise<ResultReplyResolution> {
  const { wu, metadata, result, guardUpdates } = input;
  const wuId = wu.id;
  let { action } = input;

  // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）后的委派政策
  // （通过：建子单 + collab 元数据 + delegate 卡片，父 WU 按 progress 继续；
  //  拒绝：降级 NEED_INPUT 请人裁决）已抽到 ./delegate-branch.js（2026-08 工单 05，行为不变）。
  if (action === 'delegate' && result.delegate) {
    const d = await handleDelegateBranch(
      { wu, wuId, delegate: result.delegate },
      { fileStore: host.fileStore, role: host.role, createWorkUnit: input => host.workUnitService.create(input) },
    );
    action = d.action;
    result.summary = d.summary;
    if (d.collabUpdate) guardUpdates.collab = d.collabUpdate;
  }

  // §4.2 发言层新鲜度检查（仅 recordResult → postToDiscussionSpace 结果回帖路径，系统通知不受影响）：
  // step 期间房间有外部新消息 → 不直接发帖，新消息写入 pendingReplies 注入下一轮 prompt，
  // 本步按 progress 处理；同一结果连续 2 次被拦截仍判定要发 → 照发并注明「发送时房间有新消息」。
  let skipResultPost = false;
  const freshnessUpdates: Partial<WorkUnitMetadata> = {};
  if (result.channelVersion && wu.channelId) {
    // #319：锚点 = 快照时最后一行消息 id（压实安全）；锚点行若已被压实抹除，
    // getMessagesSince 保守返回全部活消息，经下方「自己消息过滤 + 2 次拦截后照发」有界消化
    const arrived = await host.fileStore.getMessagesSince(wu.channelId, result.channelVersion.lastMessageId);
    // 本 loop 自己发的消息（如 delegate 卡片）不算「房间已变」
    const external = arrived.filter(m => !(m.authorType === 'agent' && m.agentName === host.role.name));
    const interrupts = metadata.freshnessInterrupts ?? 0;
    if (external.length > 0 && interrupts < 2) {
      skipResultPost = true;
      action = 'progress';
      freshnessUpdates.pendingReplies = external.map(m =>
        m.authorType === 'agent' ? `[${m.agentName ?? 'agent'}]: ${m.content}` : m.content
      );
      freshnessUpdates.freshnessInterrupts = interrupts + 1;
      logger.info(`[AgentLoop] Freshness: result post held for ${wuId} (${external.length} new message(s), interrupt ${interrupts + 1}/2)`);
    } else {
      if (external.length > 0) {
        result.summary = `${result.summary}（发送时房间有新消息）`;
      }
      if (interrupts > 0) {
        freshnessUpdates.freshnessInterrupts = 0;
      }
    }
  }

  return { action, skipResultPost, freshnessUpdates };
}
