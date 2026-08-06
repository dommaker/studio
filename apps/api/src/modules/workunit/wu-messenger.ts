/**
 * WU 频道系统消息统一出口（wu-messenger）。
 *
 * 收敛此前 5 处重复的「向 WorkUnit 频道线程发 Studio/agent 系统消息」实现
 * （agent-loop.postToDiscussionSpace / review-dispatcher.postSystemMessage /
 *  merge-on-review-pass.postSystemMessage / waiting-input.postStudioSystemMessage /
 *  timeout-release.postTimeoutSystemMessage）——其中 4 处只裸写 FileStore，
 * 不发 eventBus/SSE，频道页不实时可见、NotificationBell 不响。本模块统一走
 * ChannelMessageService.createAgentMessage（append + eventBus 'channel.message_sent' + SSE）。
 *
 * 形态约定：
 * - 默认 agentName='Studio'，挂在 WU 线程 anchor（首条根消息）下；显式 replyToId 时跳过 anchor 查找。
 * - milestone=true → 里程碑 meta（best-effort 解析 pmoId + atHuman:true，
 *   2026-07 PMO-flow UX §6-3/§10：NotificationBell 监听 meta.atHuman，pmoId 供跳转 PMO 详情）；
 *   opts.meta 合并覆盖里程碑 meta。
 *
 * 依赖说明：pmo-branch-resolver 走 lazy import——本模块被 merge-on-review-pass 静态依赖，
 * 后者被 workunit.service 静态依赖；静态引入 pmo-branch-resolver
 * （→ project.service → workunit.service）会成循环（同 merge-on-review-pass 头部依赖说明）。
 */
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { ChannelMessageService, type MessageMeta, type MessageRecord } from '../channels/channel-message.service.js';
import type { WorkUnitData } from './workunit.service.js';

export interface PostWuSystemMessageOptions {
  /** 消息署名（默认 'Studio'；agent-loop 回帖传本 loop 的 role.name） */
  agentName?: string;
  /** true → 里程碑消息：best-effort 解析 pmoId + atHuman:true */
  milestone?: boolean;
  /** 追加/覆盖 meta（合并于里程碑 meta 之上，可覆盖其字段） */
  meta?: MessageMeta;
  /** 显式线程锚点（提供时跳过 anchor 查找，如挂在派发消息上） */
  replyToId?: string;
  /** 测试注入；缺省 new FileStore() */
  fileStore?: FileStore;
}

/** anchor 查找（原 agent-loop.findAnchorMessage，收敛于此、不再导出）：该 WU 频道线程的首条根消息 */
async function findAnchorMessage(workUnitId: string, fileStore: FileStore): Promise<ChannelMessageData | null> {
  const messages = await fileStore.queryAllMessages({ workUnitId });
  const anchors = messages
    .filter(m => !m.replyToId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return anchors[0] ?? null;
}

/**
 * 里程碑 meta（pmoId 可解析时携带 + atHuman）。
 * lazy import 原因见头部依赖说明；import/解析失败 → 只缺 pmoId，不阻断消息发送。
 */
async function milestoneMeta(wu: WorkUnitData, fileStore: FileStore): Promise<MessageMeta> {
  try {
    const { resolvePmoProjectIdForWU } = await import('../requirements/pmo-branch-resolver.js');
    const pmoId = await resolvePmoProjectIdForWU(
      { reqId: wu.reqId ?? null, metadata: wu.metadata },
      fileStore,
    ).catch(() => null); // best-effort：解析不到不带 pmoId
    return { ...(pmoId ? { pmoId } : {}), atHuman: true };
  } catch {
    return { atHuman: true };
  }
}

/**
 * 向 WU 所在频道发系统消息（统一形态：authorType:'agent' + eventBus + SSE）。
 * @returns 发送成功的消息记录；content 为空或 wu.channelId 缺失时返回 null（不发帖）
 */
export async function postWuSystemMessage(
  wu: WorkUnitData,
  content: string,
  opts?: PostWuSystemMessageOptions,
): Promise<MessageRecord | null> {
  const trimmed = content.trim();
  if (!trimmed || !wu.channelId) return null;

  const fileStore = opts?.fileStore ?? new FileStore();
  const anchor = opts?.replyToId === undefined
    ? await findAnchorMessage(wu.id, fileStore).catch(() => null) // anchor 查询失败不阻断发帖
    : null;
  const meta: MessageMeta | undefined = opts?.milestone
    ? { ...await milestoneMeta(wu, fileStore), ...opts?.meta }
    : opts?.meta;

  return new ChannelMessageService(fileStore).createAgentMessage(
    wu.channelId,
    opts?.agentName ?? 'Studio',
    trimmed,
    { replyToId: opts?.replyToId ?? anchor?.id ?? undefined, meta, workUnitId: wu.id },
  );
}
