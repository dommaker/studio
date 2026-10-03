/**
 * channels 域契约——正本字段以 apps/api/src/modules/channels/channel.service.ts
 * （ChannelData，studio-shared file-store-types.ts）与 channel.routes.ts 实际 wire 行为为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 单实体/派生对象端点：`{ data: T }`（CRUD/归档/恢复/成员/派生读/附件上传/convert-to-task）
 * - 消息分页：`{ data: { messages, total, hasMore } }`（cursor 分页，非 page/limit 壳；
 *   原 `{success,data,total,hasMore}` 平铺形状退役，消息数组改名 messages 避免 data.data 嵌套）
 * - GET /:id/attachments/:attachmentId：二进制流（例外路径，无 envelope）
 * - SSE 事件负载不属于本契约（前端保留本地解析器）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';
import { workUnitSchema } from './workunit.js';

// ── 实体 ──

/** #466: 频道级「阶段→角色」路由表（profile id；某档 null/未配置 = 该阶段回池涌现） */
export const channelRoutingSchema = z.object({
  plan: z.string().nullable().optional(),
  implement: z.string().nullable().optional(),
  review: z.string().nullable().optional(),
});
export type ChannelRouting = z.infer<typeof channelRoutingSchema>;

/**
 * Channel wire 形状（= studio-shared ChannelData 全字段）。
 * 手写 interface（z.infer 在本仓 strict:false 下全字段退化可选，见 workunit.ts 说明）；
 * parity 测试见 __tests__/channels.test.ts。
 */
export interface Channel {
  id: string;
  name: string;
  type: string; // rnd | decision | system
  defaultWorkspaceId: string | null;
  defaultPath: string | null;
  discordChannelId: string | null;
  discordWebhookUrl: string | null;
  members: string; // JSON: AgentProfile ID[]
  routing?: ChannelRouting;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  defaultWorkspaceId: z.string().nullable(),
  defaultPath: z.string().nullable(),
  discordChannelId: z.string().nullable(),
  discordWebhookUrl: z.string().nullable(),
  members: z.string(),
  routing: channelRoutingSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * 频道消息 wire 形状（ChannelMessageData；REST 出口 meta 已 JSON.parse 为 object）。
 * meta 双型：REST 恒 object；string 为 SSE 原始/存量形态，前端消费侧双型兼容。
 * 手写 interface + parity（同 Channel）。
 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  workUnitId: string | null;
  authorType: string; // human | agent
  agentName: string | null;
  content: string; // Markdown
  replyToId: string | null;
  meta: Record<string, unknown> | string;
  createdAt: string; // ISO 8601（路由层 Date 序列化回 string）
}

export const channelMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  workUnitId: z.string().nullable(),
  authorType: z.string(),
  agentName: z.string().nullable(),
  content: z.string(),
  replyToId: z.string().nullable(),
  meta: z.union([z.record(z.unknown()), z.string()]),
  createdAt: z.string(),
});

// ── 派生读形状 ──

/** #272（决策 #251 Q6）：顶栏「当前 PMO」chip（派生不落库） */
export const channelCurrentPmoSchema = z.object({
  id: z.string(),
  pmoNumber: z.string(),
  title: z.string(),
  gitRepos: z.array(z.string()),
});
export type ChannelCurrentPmo = z.infer<typeof channelCurrentPmoSchema>;

/** #638：`#` 触发 PMO 自动补全候选项 */
export const channelPmoCandidateSchema = z.object({
  id: z.string(),
  pmoNumber: z.string(),
  title: z.string(),
});
export type ChannelPmoCandidate = z.infer<typeof channelPmoCandidateSchema>;

/** #443（spec #441 情境引导 02）：频道建议条目（id = 文案模板锚 + params = 模板参数） */
export const channelSuggestionSchema = z.object({
  id: z.string(),
  kind: z.enum(['status', 'action', 'prompt']),
  params: z.record(z.string(), z.string()),
  /** prompt 形态专用（#446）：预填进输入框的指令本体 */
  text: z.string().optional(),
});
export type ChannelSuggestion = z.infer<typeof channelSuggestionSchema>;

export const channelSuggestionsSchema = z.object({
  currentWuId: z.string().nullable(),
  suggestions: z.array(channelSuggestionSchema),
  /** #490：fail-closed 可观测标志——推导内部读取失败被吞时 true（此时 suggestions 必为空） */
  degraded: z.boolean().optional(),
});
export type ChannelSuggestions = z.infer<typeof channelSuggestionsSchema>;

/** #632：发送前归属预览（无 @ 无 replyTo 消息的三态归属预测） */
export const mergeTargetPreviewSchema = z.object({
  status: z.enum(['unique', 'ambiguous', 'none']),
  workUnit: z.object({ id: z.string(), title: z.string() }).optional(),
});
export type MergeTargetPreview = z.infer<typeof mergeTargetPreviewSchema>;

/** #281：@文件引用结构化载体（repo = 工程绝对路径，path = git ls-files 相对路径） */
export const fileRefSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
});
export type FileRef = z.infer<typeof fileRefSchema>;

/** #281：频道文件词表（候选集顺序，各仓 git ls-files） */
export const channelFileVocabularySchema = z.object({
  repos: z.array(z.object({ repo: z.string(), files: z.array(z.string()) })),
});
export type ChannelFileVocabulary = z.infer<typeof channelFileVocabularySchema>;

/** AC-E2：convert-to-task 的 LLM 建议（非阻断，失败回空对象） */
export const convertSuggestionSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  suggestedAssigneeId: z.string().optional(),
  suggestedProjectPath: z.string().optional(),
});
export type ConvertSuggestion = z.infer<typeof convertSuggestionSchema>;

/** 频道图片上传结果（相对 URL，渲染时现拼 ?token=） */
export const savedImageSchema = z.object({
  id: z.string(),
  url: z.string(),
  size: z.number(),
});
export type SavedImage = z.infer<typeof savedImageSchema>;

// ── 请求：query / params ──

/** GET /:id/messages（before = 锚点消息 id 游标；limit 数字串 handler 归一 ≤100；includeTotal='true' 才实算 total） */
export const listChannelMessagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.string().optional(),
  includeTotal: z.string().optional(),
});
export type ListChannelMessagesQuery = z.infer<typeof listChannelMessagesQuerySchema>;

export const channelIdParamsSchema = z.object({ id: z.string().min(1) });
export type ChannelIdParams = z.infer<typeof channelIdParamsSchema>;

export const attachmentParamsSchema = z.object({
  id: z.string().min(1),
  attachmentId: z.string().min(1),
});
export type AttachmentParams = z.infer<typeof attachmentParamsSchema>;

export const channelMessageParamsSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
});
export type ChannelMessageParams = z.infer<typeof channelMessageParamsSchema>;

// ── 请求：body ──

/** POST / 创建频道（type 缺省 'rnd'；agents = 可选初始角色；defaultPath 空白归一为 null 在 handler） */
export const createChannelBodySchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['rnd', 'decision', 'system']).default('rnd'),
  members: z.array(z.string()).optional(),
  agents: z.array(z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    provider: z.string().optional(),
  })).optional(),
  defaultPath: z.string().nullable().optional(),
});
export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

/** POST /:id/messages 发消息（content trim 后非空；intent/files 形状校验自手写 guard 收进 zod） */
export const sendChannelMessageBodySchema = z.object({
  content: z.string().trim().min(1),
  replyToId: z.string().optional(),
  reqId: z.string().optional(),
  files: z.array(fileRefSchema).optional(),
  intent: z.enum(['new-task', 'plain']).optional(),
});
export type SendChannelMessageBody = z.infer<typeof sendChannelMessageBodySchema>;

/**
 * PATCH /:id 设置更新（全可选）。
 * defaultProfileId 已退役——携带即 400（handler 守卫，定制文案；schema 用 passthrough
 * 放行未知键让守卫能看到它，其余未知键同旧行为被 handler 忽略）；defaultWorkspaceId
 * 归一/校验（'' / null = 清除，非空须已注册）与 routing 逐档校验（未知阶段键/非 active
 * profile 400）在 handler（异步，查 workspace/profile）。
 */
export const updateChannelBodySchema = z.object({
  name: z.string().optional(),
  defaultWorkspaceId: z.unknown().optional(),
  defaultPath: z.string().nullable().optional(),
  routing: z.record(z.string(), z.string().nullable()).optional(),
}).passthrough();
export type UpdateChannelBody = z.infer<typeof updateChannelBodySchema>;

/** PATCH /:id/members（add/remove 均为 profile id 数组；成员合法性校验在 service） */
export const updateChannelMembersBodySchema = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});
export type UpdateChannelMembersBody = z.infer<typeof updateChannelMembersBodySchema>;

/** POST /:id/attachments 图片上传（JSON base64；mime 白名单/5MB 上限校验在 attachments.ts，含 413） */
export const uploadAttachmentBodySchema = z.object({
  mime: z.string().optional(),
  dataBase64: z.string().optional(),
});
export type UploadAttachmentBody = z.infer<typeof uploadAttachmentBodySchema>;

/** POST /:id/messages/:messageId/convert-to-task（全可选；语义校验在 convert-to-task.service） */
export const convertToTaskBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  projectPath: z.string().optional(),
  reqId: z.string().optional(),
});
export type ConvertToTaskBody = z.infer<typeof convertToTaskBodySchema>;

/** #632：发送 intent——'new-task' 显式建未指派 WU（涌现认领）并关联消息；'plain' 强制纯存储；不传 = 自动合并判定 */
export type SendIntent = z.infer<typeof sendChannelMessageBodySchema>['intent'];

// ── 响应 ──

/** GET /：`{ data: Channel[] }`（原 {success,data}） */
export const channelListResponseSchema = dataBodySchema(z.array(channelSchema));

/** 单 Channel 端点通用壳：`{ data: Channel }`（get/create 201/update） */
export const channelResponseSchema = dataBodySchema(channelSchema);

/** GET /:id/current-pmo：`{ data: ChannelCurrentPmo | null }` */
export const channelCurrentPmoResponseSchema = dataBodySchema(channelCurrentPmoSchema.nullable());

/** GET /:id/pmo-candidates：`{ data: ChannelPmoCandidate[] }` */
export const channelPmoCandidatesResponseSchema = dataBodySchema(z.array(channelPmoCandidateSchema));

/** GET /:id/suggestions：`{ data: ChannelSuggestions }` */
export const channelSuggestionsResponseSchema = dataBodySchema(channelSuggestionsSchema);

/** GET /:id/merge-target：`{ data: MergeTargetPreview }` */
export const mergeTargetResponseSchema = dataBodySchema(mergeTargetPreviewSchema);

/** GET /:id/messages：`{ data: { messages, total, hasMore } }`（cursor 分页，非 page/limit 壳）。
 *  ChannelMessagesResult 手写 interface（消息面 store 按必填消费）；parity 测试见 __tests__。 */
export interface ChannelMessagesResult {
  messages: ChannelMessage[];
  total: number;
  hasMore: boolean;
}

export const channelMessagesResultSchema = z.object({
  messages: z.array(channelMessageSchema),
  total: z.number(),
  hasMore: z.boolean(),
});
export const channelMessagesResponseSchema = dataBodySchema(channelMessagesResultSchema);

/** POST /:id/messages：`{ data: ChannelMessage }`（201） */
export const channelMessageResponseSchema = dataBodySchema(channelMessageSchema);

/** GET /:id/file-vocabulary：`{ data: ChannelFileVocabulary }` */
export const channelFileVocabularyResponseSchema = dataBodySchema(channelFileVocabularySchema);

/** POST /:id/attachments：`{ data: SavedImage }`（201） */
export const savedImageResponseSchema = dataBodySchema(savedImageSchema);

/** DELETE /:id：`{ data: { deleted, fallbackChannelId } }` */
export const deleteChannelResultSchema = z.object({
  deleted: z.boolean(),
  fallbackChannelId: z.string(),
});
export type DeleteChannelResult = z.infer<typeof deleteChannelResultSchema>;
export const deleteChannelResponseSchema = dataBodySchema(deleteChannelResultSchema);

/** PUT /:id/archive：`{ data: { archived, newName } }` */
export const archiveChannelResultSchema = z.object({
  archived: z.boolean(),
  newName: z.string(),
});
export type ArchiveChannelResult = z.infer<typeof archiveChannelResultSchema>;
export const archiveChannelResponseSchema = dataBodySchema(archiveChannelResultSchema);

/** PUT /:id/restore：`{ data: { restored, name } }` */
export const restoreChannelResultSchema = z.object({
  restored: z.boolean(),
  name: z.string(),
});
export type RestoreChannelResult = z.infer<typeof restoreChannelResultSchema>;
export const restoreChannelResponseSchema = dataBodySchema(restoreChannelResultSchema);

/** PATCH /:id/members：`{ data: { members, warning? } }`（#497 移出被指名角色附 warning，不阻断） */
export const updateMembersResultSchema = z.object({
  members: z.array(z.string()),
  warning: z.string().optional(),
});
export type UpdateMembersResult = z.infer<typeof updateMembersResultSchema>;
export const updateMembersResponseSchema = dataBodySchema(updateMembersResultSchema);

/** POST convert-to-task：`{ data: WorkUnit }`（201，复用 workunit 域实体） */
export const convertToTaskResponseSchema = dataBodySchema(workUnitSchema);

/** POST convert-to-task/suggest：`{ data: ConvertSuggestion }`（失败也 200 空对象，非阻断） */
export const convertSuggestionResponseSchema = dataBodySchema(convertSuggestionSchema);
