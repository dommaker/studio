// AgentLoop 观察→目标解析（纯代码，零 LLM）—— 从 agent-loop.ts 原样抽出，行为不变。
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import type { WorkUnitData } from '../workunit/workunit.service.js';

/** Observation collected from DB */
export interface Observations {
  myActive: WorkUnitData[];
  unassigned: WorkUnitData[];
  newReplies: ChannelMessageData[];
}

/** Resolved target for agentStep */
export interface Target {
  workUnit: WorkUnitData;
  newReplies?: ChannelMessageData[];
}

/** Find the anchor message (first message, no replyToId) for a WorkUnit */
export async function findAnchorMessage(workUnitId: string, fileStore?: FileStore): Promise<ChannelMessageData | null> {
  const fs = fileStore ?? new FileStore();
  const messages = await fs.queryAllMessages({ workUnitId });
  const anchors = messages
    .filter(m => !m.replyToId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return anchors[0] ?? null;
}

/** Resolve target from observations (pure code, zero LLM) */
export function resolveTarget(obs: Observations): Target | null {
  // Priority 1: human reply (including blocked WorkUnit)
  if (obs.newReplies.length > 0) {
    const repliedWuId = obs.newReplies[0].workUnitId;
    const wu = obs.myActive.find(w => w.id === repliedWuId);
    if (wu) return { workUnit: wu, newReplies: obs.newReplies };
  }

  // Priority 2: active WorkUnit continues
  const activeWu = obs.myActive.find(w => w.status === 'active');
  if (activeWu) return { workUnit: activeWu };

  // Priority 3: idle, take earliest unassigned
  if (obs.unassigned.length > 0) {
    return { workUnit: obs.unassigned[0] };
  }

  // No target
  return null;
}
