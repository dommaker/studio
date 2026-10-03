// Channel Routes — B1-001/B1-002/B1-009/B1-011
// #532：频道记录读写收口 channel.service——404 判定单点（getOrThrow + ChannelError 映射），
// 写路径内部失效列表缓存；路由只剩 HTTP 装配（参数 + 状态码）。
// 契约驱动迁移（2026-09 批次 1/7）：全部端点走 core/http.ts defineRoute——
// zod 校验入参（手写 guard 收进 schema）、统一 envelope（{ data }，消息分页 { data:{messages,total,hasMore} }）、
// ChannelError 经 channelErrorToHttp 转 HttpError（status 自带：400/404/409）。
import { Router, json } from 'express';
import { randomUUID } from 'crypto';
import { createReadStream } from 'node:fs';
import {
  createChannelBodySchema,
  sendChannelMessageBodySchema,
  updateChannelBodySchema,
  updateChannelMembersBodySchema,
  uploadAttachmentBodySchema,
  convertToTaskBodySchema,
  listChannelMessagesQuerySchema,
  channelIdParamsSchema,
  attachmentParamsSchema,
  channelMessageParamsSchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { logger } from '@dommaker/studio-shared';
import { channelService, ChannelError, validateDefaultWorkspaceId } from './channel.service.js';
import { saveChannelImage, resolveChannelImage, ATTACHMENT_BODY_LIMIT } from './attachments.js';
import { routeMessage, resolveMergeTarget } from './message-routing.js';
import { WorkUnitService } from '../workunit/index.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { requireAuth } from '../../middleware/auth.js';
import { ConvertToTaskService } from './convert-to-task.service.js';
import { ProjectDiscoveryService } from '../projects/index.js';
import { getChannelFileVocabulary } from './file-ref-vocabulary.js';
import { deriveChannelCurrentPmo } from './current-pmo.js';
import { deriveChannelPmoCandidates } from './pmo-candidates.js';
import { deriveChannelSuggestions } from './suggestions.js';
import { getErrorMessage } from '../../utils/errors.js';
import { validateRouting, buildMemberRemovalWarning } from './routing.js';
import { defineRoute, HttpError } from '../../core/http.js';
import { getStore } from '../../core/store.js';


// P2-e 鉴权声明式统一：read（GET 读，registry 挂 requireAuth）/ write（registry 挂 authNotGuest）拆 router，
// 路由内不再挂鉴权。唯一例外 = 附件 GET（channelAttachmentRoutes，文件尾部）：<img> 的 ?token= 需
// tokenQueryToHeader 先于 requireAuth 执行，route-registry 无 per-route 前置 middleware 能力，
// 该单条鉴权保留路由内（registry 先挂 attachment 小 router 再挂 read router，姿态注释见 entry）。
const readRoutes = Router();
const writeRoutes = Router();
const convertToTaskService = new ConvertToTaskService(getStore());
const projectDiscoveryService = new ProjectDiscoveryService();

/** ChannelError（status 自带 400/404/409）→ HttpError；其余错误原样上抛交 defineRoute 兜底 */
function channelErrorToHttp(e: unknown): never {
  if (e instanceof ChannelError) {
    const code = e.status === 404 ? ERROR_CODES.NOT_FOUND
      : e.status === 409 ? ERROR_CODES.CONFLICT
      : ERROR_CODES.BAD_REQUEST;
    throw new HttpError(e.status, code, e.message);
  }
  throw e;
}

/** 包一段可能抛 ChannelError 的调用（service 逻辑不动，路由层只做错误翻译） */
async function translating<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    channelErrorToHttp(e);
  }
}

// GET /api/v1/channels — list all non-archived channels
// 2026-09-14：读侧与写侧对称补 requireAuth（P2-e 起挂载上移至 route-registry）
readRoutes.get('/', apiCache(CACHE_CONFIG.medium), defineRoute({}, async () => {
  return channelService.listVisibleChannels();
}));

// POST /api/v1/channels — create a new channel (B2-007)
// Also supports creating initial agents: { agents: [{ name, description? }] }
// #272（决策 #251 Q7）：创建表单可选「默认工程」（本地 repo 路径，可留空）
writeRoutes.post('/', defineRoute({ body: createChannelBodySchema }, { status: 201 }, async (_req, _res, { body }) => {
  const defaultPathValue = typeof body.defaultPath === 'string' && body.defaultPath.trim() ? body.defaultPath.trim() : null;
  return translating(channelService.create({
    name: body.name,
    type: body.type,
    defaultPath: defaultPathValue,
    // z.infer 在本仓 strict:false 下全字段退化可选（schema 运行时仍必填 name）——边界显式收回
    agents: body.agents?.map(a => ({ name: a.name as string, description: a.description, provider: a.provider })),
    members: body.members,
  }));
}));

// GET /api/v1/channels/:id — get channel detail
// B8（2026-09-16 channel 性能审计）：去掉 prisma 时代遗留的 `_count.ChannelMessage`
// （全仓无消费方，每请求 O(热文件行数) 全量计数纯浪费；计数方法已随 B4 清扫删除）
readRoutes.get('/:id', defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  return translating(channelService.getOrThrow(params.id));
}));

// GET /api/v1/channels/:id/current-pmo — #272（决策 #251 Q6）：顶栏「当前 PMO」chip
// 派生概念不落库：最近挂接 REQ 所属 PMO → 杂务 PMO 反推 → null（见 current-pmo.ts）。
// B7：派生链为 N+1 全量读取，挂短 TTL apiCache（5s 档，同 GET / 列表先例）。
readRoutes.get('/:id/current-pmo', apiCache(CACHE_CONFIG.short), defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  await translating(channelService.getOrThrow(params.id));
  return deriveChannelCurrentPmo(params.id);
}));

// GET /api/v1/channels/:id/pmo-candidates — #638：`#` 触发 PMO 自动补全弹框的候选集。
// 当前 PMO 置顶 + 挂接 REQ 所属 PMO（seq 降序去重，pmoNumber 为空过滤）；派生不落库，
// 与 current-pmo 同为 N+1 全量读取挂短 TTL apiCache；派生内部容错绝不抛出（无来源 → []）。
readRoutes.get('/:id/pmo-candidates', apiCache(CACHE_CONFIG.short), defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  await translating(channelService.getOrThrow(params.id));
  return deriveChannelPmoCandidates(params.id);
}));

// GET /api/v1/channels/:id/suggestions — #443（spec #441 情境引导 02）：频道建议派生端点。
// 不落库、按当前事实现算；fail-closed（前置不满足/拿不准不出）。本票只交付 status
// 只读状态说明形态（自动评审在途）；action/prompt 形态见 #444/#445/#446（见 suggestions.ts）。
// B2：前端每条 agent 消息都重拉、每次全量 WU 派生，挂短 TTL apiCache（5s 档，同 current-pmo 先例）。
readRoutes.get('/:id/suggestions', apiCache(CACHE_CONFIG.short), defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  await translating(channelService.getOrThrow(params.id));
  return deriveChannelSuggestions(params.id, { fileStore: getStore() });
}));

// GET /api/v1/channels/:id/merge-target — #632：发送前归属预览（只读）。
// 与 routeMessage 无地址路径共用 resolveMergeTarget 判定，保证「预览所见 = 实际路由」：
// unique 附 workUnit{id,title}（标题 = WU scope）；ambiguous 不暴露并入目标。
readRoutes.get('/:id/merge-target', defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  await translating(channelService.getOrThrow(params.id));
  const wuService = new WorkUnitService(getStore());
  const resolution = await resolveMergeTarget(params.id, getStore(), wuService);
  if (resolution.kind !== 'unique') {
    return { status: resolution.kind };
  }
  const wu = await wuService.getById(resolution.target.id);
  return { status: 'unique', workUnit: { id: resolution.target.id, title: wu?.scope ?? '' } };
}));

// GET /api/v1/channels/:id/messages — paginated messages
// #319：before = 锚点消息 id 游标（原 timestamp 游标同毫秒撞车会漏/重）；分页半下沉到存储层（queryMessagesPage 切片）
readRoutes.get('/:id/messages', defineRoute(
  { params: channelIdParamsSchema, query: listChannelMessagesQuerySchema },
  async (_req, _res, { params, query }) => {
    const take = Math.min(Number(query.limit ?? '50'), 100);

    const page = await getStore().queryMessagesPage(params.id, {
      before: query.before || undefined,
      limit: take,
      // #525 P2-4：total 默认跳过（countColdLines 逐冷月字节扫纯浪费，前端不消费）；
      // 要总数的调用方显式 ?includeTotal=true 开口
      includeTotal: query.includeTotal === 'true',
    });

    // 解析 meta JSON，转换 createdAt 类型（JSON 序列化回 string）
    const messages = page.messages.map(m => ({
      ...m,
      meta: typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta,
      createdAt: new Date(m.createdAt),
    }));

    return { messages, total: page.total, hasMore: page.hasMore };
  },
));

// GET /api/v1/channels/:id/file-vocabulary — #281：@文件引用只读词表
// 候选集 = 频道相关工程（默认工程 ∪ REQ 挂接 PMO ∪ 杂务 PMO，最近使用优先），
// 各仓 git ls-files + 内存缓存（见 file-ref-vocabulary.ts）。
// B7：挂短 TTL apiCache（5s 档）——词表进程缓存之外再挡一层 HTTP 级重复派生。
readRoutes.get('/:id/file-vocabulary', apiCache(CACHE_CONFIG.short), defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  await translating(channelService.getOrThrow(params.id));
  try {
    return await getChannelFileVocabulary(params.id);
  } catch (e: unknown) {
    logger.warn('[Channel] file vocabulary failed', { channelId: params.id, error: getErrorMessage(e) });
    throw e; // defineRoute 兜底 500 INTERNAL（原 {success:false,error} 壳退役）
  }
}));

// POST /api/v1/channels/:id/messages — send a message
writeRoutes.post('/:id/messages', defineRoute(
  { params: channelIdParamsSchema, body: sendChannelMessageBodySchema },
  { status: 201 },
  async (req, _res, { params, body }) => {
    const channelId = params.id;

    const channel = await translating(channelService.getOrThrow(channelId));

    // P0 修复 6 + #519: traceId — 复用 audit 中间件落在 req 上的 requestId（同一次 HTTP 请求同值），
    // 没有则新建（如单测直连路由）；三条派单路径建出/关联的 WU 统一写入 metadata.traceId。
    const traceId = (req as any).requestId ?? randomUUID();

    // #481：body.workspaceId（F6 显式机器指针）已退役，不再接收/生效
    return routeMessage(
      channelId,
      body.content,
      body.replyToId || undefined,
      {
        // REQ 需求编号（vision §5.3）：调用方可显式指定（缺省走 #REQ-XXXX token / 自动新建）
        reqId: body.reqId || undefined,
        traceId,
        // #281: @文件引用（路由层做存在性校验 + 剔除播报）
        // z.infer 退化可选同上——边界显式收回（schema 运行时仍 min(1) 必填）
        files: body.files?.map(f => ({ repo: f.repo as string, path: f.path as string })),
        // #632: 归属预览的显式意图覆盖（new-task 建未指派 WU / plain 纯存储）
        intent: body.intent,
        // #525 P2-2（决策 #517 项 3）：上方 404 判定已读出的 channel 透传，消 routeMessage 重复读
        channel,
      },
    );
  },
));

// POST /api/v1/channels/:id/attachments — 频道图片上传（2026-09，「频道里加上截图」）
// JSON base64 体（不引 multipart 依赖）；该路由单独放大 json limit（8mb，全局 2mb 不动）——
// app.ts 在全局 parser 前对同路径预解析，此处路由级再挂保直挂测试自足（已解析请求自动跳过）。
writeRoutes.post('/:id/attachments', json({ limit: ATTACHMENT_BODY_LIMIT }), defineRoute(
  { params: channelIdParamsSchema, body: uploadAttachmentBodySchema },
  { status: 201 },
  async (_req, _res, { params, body }) => {
    await translating(channelService.getOrThrow(params.id));
    const result = await saveChannelImage(params.id, body);
    if (!result.ok) {
      // 领域校验自带状态码（400 白名单/base64、413 超 5MB）；413 无标准码词表，用业务自定义码
      throw new HttpError(result.status!, result.status === 413 ? 'PAYLOAD_TOO_LARGE' : ERROR_CODES.BAD_REQUEST, result.error!);
    }
    return result.value;
  },
));

// GET /api/v1/channels/:id/attachments/:attachmentId — 取图

// DELETE /api/v1/channels/:id — delete channel (B2-012: Goal fallback to #研发)
writeRoutes.delete('/:id', defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  const { fallbackChannelId } = await translating(channelService.deleteWithFallback(params.id));
  return { deleted: true, fallbackChannelId };
}));

// PUT /api/v1/channels/:id/archive — archive a channel (B1-011)
writeRoutes.put('/:id/archive', defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  const newName = await translating(channelService.archive(params.id));
  return { archived: true, newName };
}));

// PUT /api/v1/channels/:id/restore — restore an archived channel (B1-011)
writeRoutes.put('/:id/restore', defineRoute({ params: channelIdParamsSchema }, async (_req, _res, { params }) => {
  const name = await translating(channelService.restore(params.id));
  return { restored: true, name };
}));

// PATCH /api/v1/channels/:id — update channel settings
writeRoutes.patch('/:id', defineRoute(
  { params: channelIdParamsSchema, body: updateChannelBodySchema },
  async (req, _res, { params, body }) => {
    // #632：defaultProfileId（决策12 频道默认角色）已退役——不再接受该字段（定制文案，zod 不收）
    if ('defaultProfileId' in (req.body ?? {})) {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'defaultProfileId 已随 #632 退役：无 @ 消息归宿 = 合并窗口 / 纯存储，频道不再配置默认角色');
    }
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.defaultWorkspaceId !== undefined) {
      // F6: '' → 清除默认工程；非空时校验 workspace 已注册
      const validated = await validateDefaultWorkspaceId(body.defaultWorkspaceId);
      if (!validated.ok) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, validated.error!);
      }
      data.defaultWorkspaceId = validated.value;
    }
    if (body.defaultPath !== undefined) data.defaultPath = body.defaultPath;
    // #466: 阶段→角色路由表（吞并 defaultPipeline）；值须为 active profile id，'' / null 清除该档
    if (body.routing !== undefined) {
      const validated = await validateRouting(getStore(), body.routing);
      if (!validated.ok) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, validated.error!);
      }
      // 与存量合并在 service.update 内部（单档更新不清掉其他档；显式 null = 清除该档）
      if (validated.value) {
        data.routing = validated.value;
      }
    }
    return translating(channelService.update(params.id, data as Partial<import('@dommaker/studio-shared').ChannelData>));
  },
));

// PATCH /api/v1/channels/:id/members — update channel members (AC-B2)
writeRoutes.patch('/:id/members', defineRoute(
  { params: channelIdParamsSchema, body: updateChannelMembersBodySchema },
  async (_req, _res, { params, body }) => {
    const members = await translating(channelService.updateMembers(params.id, { add: body.add, remove: body.remove }));
    // #497: 移出被指名角色（routing 档/入口角色）→ 响应附 warning 提示漂移（不阻断，
    // 与现有校验严格度对齐——指名静默退化为涌现前给人一次知情机会）
    const removed = body.remove ?? [];
    let warning: string | undefined;
    if (removed.length > 0) {
      const channel = await translating(channelService.getOrThrow(params.id));
      warning = buildMemberRemovalWarning(channel, removed);
    }
    return { members, ...(warning ? { warning } : {}) };
  },
));

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task (AC-E1)
writeRoutes.post('/:id/messages/:messageId/convert-to-task', defineRoute(
  { params: channelMessageParamsSchema, body: convertToTaskBodySchema },
  {
    status: 201,
    errors: [
      { match: 'not found', status: 404, code: ERROR_CODES.NOT_FOUND },
      { match: 'already', status: 400, code: ERROR_CODES.BAD_REQUEST },
    ],
  },
  async (_req, _res, { params, body }) => {
    return convertToTaskService.convert(params.id, params.messageId, body);
  },
));

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task/suggest (AC-E2)
writeRoutes.post('/:id/messages/:messageId/convert-to-task/suggest', defineRoute(
  { params: channelMessageParamsSchema },
  async (_req, _res, { params }) => {
    try {
      // 1. Get message content（#524 P1-1：路径参数 :id 即频道，按频道直查免全频道扇出）
      const found = await getStore().getMessageById(params.messageId, params.id);
      if (!found) {
        throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Message not found');
      }
      const message = found.message;

      // 2/3. Get available agents + projects（互不依赖，并行拉取——B2）
      const [allProfiles, projects] = await Promise.all([
        getStore().listProfiles({ status: 'active' }),
        projectDiscoveryService.discover(),
      ]);
      const agents = allProfiles.map(p => ({ id: p.id, name: p.name, description: p.description }));

      // 4. Get LLM suggestion
      return await convertToTaskService.suggest(
        message.content,
        agents,
        projects.map(p => ({ name: p.name, path: p.path })),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Non-blocking: return empty suggestion on error
      logger.warn('[ConvertToTask] Suggest endpoint error (non-blocking)', { error: String(error) });
      return {};
    }
  },
));



/** <img>/EventSource 无法带 Authorization 头：?token= → header 后走 requireAuth（optionalAuth 同款先例） */
function tokenQueryToHeader(req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

/**
 * 附件 GET 专用小 router（P2-e）：?token= 需 tokenQueryToHeader 先于 requireAuth，
 * route-registry 支持不了 per-route 前置 middleware，此单条鉴权保留路由内。
 * registry 须先于 channelReadRoutes 挂载。
 */
export const channelAttachmentRoutes = Router();
// <img> 无法带 Authorization 头：?token= 携带 JWT（SSE /events/stream 同款），
// 映射进 header 后复用 requireAuth 语义；id 白名单校验防路径穿越（attachments.ts）。
// 二进制流例外路径：handler 自写响应（pipe 至 finish 才返回，否则 defineRoute 会在
// headersSent 之前 end() 截断流），defineRoute 见 headersSent 直返。
channelAttachmentRoutes.get('/:id/attachments/:attachmentId', tokenQueryToHeader, requireAuth(), defineRoute({ params: attachmentParamsSchema }, async (_req, res, { params }) => {
  const resolved = await resolveChannelImage(params.id, params.attachmentId);
  if (!resolved.ok) {
    throw new HttpError(resolved.status!, resolved.status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.BAD_REQUEST, resolved.error!);
  }
  res.setHeader('Content-Type', resolved.value!.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  await new Promise<void>((resolve, reject) => {
    createReadStream(resolved.value!.filePath).pipe(res).on('finish', resolve).on('error', reject);
  });
  return undefined;
}));

export { readRoutes as channelReadRoutes, writeRoutes as channelWriteRoutes };
