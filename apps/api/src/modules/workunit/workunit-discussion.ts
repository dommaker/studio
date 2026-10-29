import type { FileStore } from '@dommaker/studio-shared';
import type { PatchMessageBody, PostMessageBody } from '@dommaker/studio-contract';
import type { WorkUnitQuery } from './workunit-query.js';
import { getRequiredWorkUnit, WorkUnitApplicationError } from './workunit-application.js';
import {
  workUnitPort,
  type WorkUnitMessageMeta,
  type WorkUnitMessagePort,
  type WorkUnitMessageRecord,
} from './workunit-ports.js';

export interface WorkUnitDiscussionDeps {
  service: Pick<WorkUnitQuery, 'getById'>;
  fileStore: FileStore;
  message?: WorkUnitMessagePort;
}

async function messagePort(deps: WorkUnitDiscussionDeps): Promise<WorkUnitMessagePort> {
  return deps.message ?? workUnitPort('message');
}

export async function listDiscussionMessages(
  workUnitId: string,
  options: { limit: number; before?: Date },
  deps: WorkUnitDiscussionDeps,
): Promise<{ messages: WorkUnitMessageRecord[]; total: number; hasMore: boolean }> {
  // WU 缺失或无 channelId 时保留 message port 的扇出 fallback。
  const wu = await deps.service.getById(workUnitId);
  const result = await (await messagePort(deps)).listByWorkUnitId({
    fileStore: deps.fileStore,
    workUnitId,
    channelId: wu?.channelId ?? undefined,
    before: options.before,
    limit: options.limit,
  });
  return {
    messages: result.data,
    total: result.total,
    hasMore: result.data.length < result.total,
  };
}

export async function postDiscussionMessage(
  workUnitId: string,
  input: PostMessageBody,
  deps: WorkUnitDiscussionDeps,
): Promise<WorkUnitMessageRecord> {
  const wu = await getRequiredWorkUnit(workUnitId, deps.service);
  let channelId = wu.channelId;
  if (!channelId) {
    const rndChannels = await deps.fileStore.listChannels({ type: 'rnd' });
    channelId = rndChannels[0]?.id ?? null;
    if (!channelId) {
      throw new WorkUnitApplicationError('NO_CHANNEL', 'No channel available for discussion messages');
    }
  }

  const { content, replyToId, authorType = 'human', agentName } = input;
  const message = await messagePort(deps);
  if (authorType === 'agent' && agentName) {
    return message.createAgentMessage({
      fileStore: deps.fileStore, channelId, agentName, content, replyToId, workUnitId,
    });
  }
  return message.createHumanMessage({ fileStore: deps.fileStore, channelId, content, replyToId, workUnitId });
}

export async function patchDiscussionMessage(
  workUnitId: string,
  messageId: string,
  input: PatchMessageBody,
  deps: WorkUnitDiscussionDeps,
): Promise<WorkUnitMessageRecord> {
  const { content, meta } = input;
  if (content === undefined && meta === undefined) {
    throw new WorkUnitApplicationError('INVALID_INPUT', 'content or meta is required');
  }

  const wu = await deps.service.getById(workUnitId);
  const found = await deps.fileStore.getMessageById(messageId, wu?.channelId ?? undefined);
  if (!found) {
    throw new WorkUnitApplicationError('NOT_FOUND', `Message ${messageId} not found`);
  }
  if (found.message.workUnitId !== workUnitId) {
    throw new WorkUnitApplicationError('INVALID_INPUT', 'Message does not belong to this WorkUnit');
  }

  return (await messagePort(deps)).updateMessage({
    fileStore: deps.fileStore,
    messageId,
    channelId: found.channelId,
    content,
    meta: meta as WorkUnitMessageMeta | undefined,
  });
}
