// Channel Routes — B1-001/B1-002/B1-009/B1-011
// #532：频道记录读写收口 channel.service——404 判定单点（getOrThrow + handle 映射），
// 写路径内部失效列表缓存；路由只剩 HTTP 装配（参数 + 状态码）。
import { Router, json } from 'express';
import { randomUUID } from 'crypto';
import { createReadStream } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { logger, FileStore } from '@dommaker/studio-shared';
import { channelService, ChannelError, validateDefaultWorkspaceId } from './channel.service.js';
import { saveChannelImage, resolveChannelImage, ATTACHMENT_BODY_LIMIT } from './attachments.js';
import { routeMessage } from './message-routing.js';
import { projectService } from '../pmo/project.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { ConvertToTaskService } from './convert-to-task.service.js';
import { ProjectDiscoveryService } from '../projects/project-discovery.service.js';
import { getChannelFileVocabulary } from './file-ref-vocabulary.js';
import { deriveChannelCurrentPmo } from './current-pmo.js';
import { deriveChannelSuggestions } from './suggestions.js';
import { getErrorMessage } from '../../utils/errors.js';
import { validateRouting, buildMemberRemovalWarning } from './routing.js';

const router = Router();
const fileStore = new FileStore();
const convertToTaskService = new ConvertToTaskService(fileStore);
const projectDiscoveryService = new ProjectDiscoveryService();

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

/** ChannelError → 对应状态码 + {success:false, error}；其余错误交全局 errorHandler */
function handle(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e: unknown) => {
      if (e instanceof ChannelError) {
        res.status(e.status).json({ success: false, error: e.message });
        return;
      }
      next(e);
    });
  };
}

// GET /api/v1/channels — list all non-archived channels
// 2026-09-14：读侧与写侧对称补 requireAuth
router.get('/', requireAuth(), apiCache(CACHE_CONFIG.medium), handle(async (_req, res) => {
  const channels = await channelService.listVisibleChannels();
  res.json({ success: true, data: channels });
}));

// POST /api/v1/channels — create a new channel (B2-007)
// Also supports creating initial agents: { agents: [{ name, description? }] }
router.post('/', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const { name, type = 'rnd', members, agents, defaultPath } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!['rnd', 'decision', 'system'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be rnd, decision, or system' });
  }
  // #272（决策 #251 Q7）：创建表单可选「默认工程」（本地 repo 路径，可留空）
  if (defaultPath !== undefined && defaultPath !== null && typeof defaultPath !== 'string') {
    return res.status(400).json({ success: false, error: 'defaultPath must be a string' });
  }
  const defaultPathValue = typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath.trim() : null;
  const finalChannel = await channelService.create({ name, type, defaultPath: defaultPathValue, agents, members });
  res.status(201).json({ success: true, data: finalChannel });
}));

// GET /api/v1/channels/:id — get channel detail
// B8（2026-09-16 channel 性能审计）：去掉 prisma 时代遗留的 `_count.ChannelMessage`
// （全仓无消费方，每请求 O(热文件行数) 全量 countMessages 纯浪费）
router.get('/:id', requireAuth(), handle(async (req, res) => {
  const channel = await channelService.getOrThrow(req.params.id);
  res.json({ success: true, data: channel });
}));

// GET /api/v1/channels/:id/current-pmo — #272（决策 #251 Q6）：顶栏「当前 PMO」chip
// 派生概念不落库：最近挂接 REQ 所属 PMO → 杂务 PMO 反推 → null（见 current-pmo.ts）。
// B7：派生链为 N+1 全量读取，挂短 TTL apiCache（5s 档，同 GET / 列表先例）。
router.get('/:id/current-pmo', requireAuth(), apiCache(CACHE_CONFIG.short), handle(async (req, res) => {
  await channelService.getOrThrow(req.params.id);
  const pmo = await deriveChannelCurrentPmo(req.params.id);
  res.json({ success: true, data: pmo });
}));

// GET /api/v1/channels/:id/suggestions — #443（spec #441 情境引导 02）：频道建议派生端点。
// 不落库、按当前事实现算；fail-closed（前置不满足/拿不准不出）。本票只交付 status
// 只读状态说明形态（自动评审在途）；action/prompt 形态见 #444/#445/#446（见 suggestions.ts）。
router.get('/:id/suggestions', requireAuth(), handle(async (req, res) => {
  await channelService.getOrThrow(req.params.id);
  const data = await deriveChannelSuggestions(req.params.id, { fileStore });
  res.json({ success: true, data });
}));

// GET /api/v1/channels/:id/messages — paginated messages
// #319：before = 锚点消息 id 游标（原 timestamp 游标同毫秒撞车会漏/重）；分页半下沉到存储层（queryMessagesPage 切片）
router.get('/:id/messages', requireAuth(), async (req, res) => {
  const { before, limit = '50' } = req.query;
  const take = Math.min(Number(limit), 100);

  const page = await fileStore.queryMessagesPage(req.params.id, {
    before: typeof before === 'string' && before ? before : undefined,
    limit: take,
    // #525 P2-4：total 默认跳过（countColdLines 逐冷月字节扫纯浪费，前端不消费）；
    // 要总数的调用方显式 ?includeTotal=true 开口
    includeTotal: req.query.includeTotal === 'true',
  });

  // 解析 meta JSON，转换 createdAt 类型
  const data = page.messages.map(m => ({
    ...m,
    meta: typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta,
    createdAt: new Date(m.createdAt),
  }));

  res.json({ success: true, data, total: page.total, hasMore: page.hasMore });
});

// GET /api/v1/channels/:id/file-vocabulary — #281：@文件引用只读词表
// 候选集 = 频道相关工程（默认工程 ∪ REQ 挂接 PMO ∪ 杂务 PMO，最近使用优先），
// 各仓 git ls-files + 内存缓存（见 file-ref-vocabulary.ts）。
// B7：挂短 TTL apiCache（5s 档）——词表进程缓存之外再挡一层 HTTP 级重复派生。
router.get('/:id/file-vocabulary', requireAuth(), apiCache(CACHE_CONFIG.short), handle(async (req, res) => {
  await channelService.getOrThrow(req.params.id);
  try {
    const vocabulary = await getChannelFileVocabulary(req.params.id);
    res.json({ success: true, data: vocabulary });
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    logger.warn('[Channel] file vocabulary failed', { channelId: req.params.id, error: msg });
    res.status(500).json({ success: false, error: msg });
  }
}));

// POST /api/v1/channels/:id/messages — send a message
router.post('/:id/messages', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const { content, replyToId, reqId, files } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ success: false, error: 'content is required' });
  }
  // #281: @文件引用结构化载体（可选）；形状不符整体 400，存在性校验在路由层
  if (files !== undefined && (!Array.isArray(files) || files.some(
    (f: unknown) => !f || typeof (f as { repo?: unknown }).repo !== 'string'
      || typeof (f as { path?: unknown }).path !== 'string'
      || !(f as { repo: string }).repo || !(f as { path: string }).path,
  ))) {
    return res.status(400).json({ success: false, error: 'files must be an array of {repo, path} strings' });
  }

  const channelId = req.params.id;
  const trimmedContent = content.trim();

  const channel = await channelService.getOrThrow(channelId);

  // P0 修复 6 + #519: traceId — 复用 audit 中间件落在 req 上的 requestId（同一次 HTTP 请求同值），
  // 没有则新建（如单测直连路由）；三条派单路径建出/关联的 WU 统一写入 metadata.traceId。
  const traceId = (req as any).requestId ?? randomUUID();

  // #481：body.workspaceId（F6 显式机器指针）已退役，不再接收/生效
  const message = await routeMessage(
    channelId,
    trimmedContent,
    replyToId || undefined,
    {
      // REQ 需求编号（vision §5.3）：调用方可显式指定（缺省走 #REQ-XXXX token / 自动新建）
      reqId: typeof reqId === 'string' && reqId ? reqId : undefined,
      traceId,
      // #281: @文件引用（路由层做存在性校验 + 剔除播报）
      files: files as { repo: string; path: string }[] | undefined,
      // #525 P2-2（决策 #517 项 3）：上方 404 判定已读出的 channel 透传，消 routeMessage 重复读
      channel,
    },
  );

  res.status(201).json({ success: true, data: message });
}));

// POST /api/v1/channels/:id/attachments — 频道图片上传（2026-09，「频道里加上截图」）
// JSON base64 体（不引 multipart 依赖）；该路由单独放大 json limit（8mb，全局 2mb 不动）——
// app.ts 在全局 parser 前对同路径预解析，此处路由级再挂保直挂测试自足（已解析请求自动跳过）。
router.post('/:id/attachments', json({ limit: ATTACHMENT_BODY_LIMIT }), requireAuth(), requireNotGuest(), handle(async (req, res) => {
  await channelService.getOrThrow(req.params.id);
  const result = await saveChannelImage(req.params.id, req.body ?? {});
  if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
  res.status(201).json({ success: true, data: result.value });
}));

// GET /api/v1/channels/:id/attachments/:attachmentId — 取图
// <img> 无法带 Authorization 头：?token= 携带 JWT（SSE /events/stream 同款），
// 映射进 header 后复用 requireAuth 语义；id 白名单校验防路径穿越（attachments.ts）。
router.get('/:id/attachments/:attachmentId', tokenQueryToHeader, requireAuth(), async (req, res) => {
  const resolved = await resolveChannelImage(req.params.id, req.params.attachmentId);
  if (!resolved.ok) return res.status(resolved.status).json({ success: false, error: resolved.error });
  res.setHeader('Content-Type', resolved.value.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  createReadStream(resolved.value.filePath).pipe(res);
});

// DELETE /api/v1/channels/:id — delete channel (B2-012: Goal fallback to #研发)
router.delete('/:id', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const { fallbackChannelId } = await channelService.deleteWithFallback(req.params.id);
  res.json({ success: true, data: { deleted: true, fallbackChannelId } });
}));

// PUT /api/v1/channels/:id/archive — archive a channel (B1-011)
router.put('/:id/archive', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const newName = await channelService.archive(req.params.id);
  res.json({ success: true, data: { archived: true, newName } });
}));

// PUT /api/v1/channels/:id/restore — restore an archived channel (B1-011)
router.put('/:id/restore', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const name = await channelService.restore(req.params.id);
  res.json({ success: true, data: { restored: true, name } });
}));

// PATCH /api/v1/channels/:id — update channel settings
router.patch('/:id', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const { id } = req.params;
  const { name, defaultWorkspaceId, defaultPath, routing, defaultProfileId } = req.body;
  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (defaultWorkspaceId !== undefined) {
    // F6: '' → 清除默认工程；非空时校验 workspace 已注册
    const validated = await validateDefaultWorkspaceId(defaultWorkspaceId);
    if (!validated.ok) {
      return res.status(400).json({ success: false, error: validated.error });
    }
    data.defaultWorkspaceId = validated.value;
  }
  if (defaultPath !== undefined) data.defaultPath = defaultPath;
  // #466: 阶段→角色路由表（吞并 defaultPipeline）；值须为 active profile id，'' / null 清除该档
  if (routing !== undefined) {
    const validated = await validateRouting(fileStore, routing);
    if (!validated.ok) {
      return res.status(400).json({ success: false, error: validated.error });
    }
    // 与存量合并在 service.update 内部（单档更新不清掉其他档；显式 null = 清除该档）
    if (validated.value) {
      data.routing = validated.value;
    }
  }
  // F5（决策 6）: 入口角色 defaultProfileId 可配置 — '' / null → 清除（@studio 与无 @ 消息回退未指派）；
  // 非空校验为已存在的 active profile（不强制频道成员，成员边界在路由时按 §9.5 判定）
  if (defaultProfileId !== undefined) {
    if (defaultProfileId === '' || defaultProfileId === null) {
      data.defaultProfileId = null;
    } else {
      const all = await fileStore.listProfiles({ status: 'active' });
      if (!all.some(p => p.id === defaultProfileId)) {
        return res.status(400).json({ success: false, error: `defaultProfileId ${defaultProfileId} 不是已存在的 active 角色` });
      }
      data.defaultProfileId = defaultProfileId;
    }
  }
  const updated = await channelService.update(id, data as Partial<import('@dommaker/studio-shared').ChannelData>);
  res.json({ success: true, data: updated });
}));

// PATCH /api/v1/channels/:id/members — update channel members (AC-B2)
router.patch('/:id/members', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const { add, remove } = req.body;
  const members = await channelService.updateMembers(req.params.id, { add, remove });
  // #497: 移出被指名角色（routing 档/入口角色）→ 响应附 warning 提示漂移（不阻断，
  // 与现有校验严格度对齐——指名静默退化为涌现前给人一次知情机会）
  const removed: string[] = Array.isArray(remove) ? remove.filter((x): x is string => typeof x === 'string') : [];
  let warning: string | undefined;
  if (removed.length > 0) {
    const channel = await channelService.getOrThrow(req.params.id);
    warning = buildMemberRemovalWarning(channel, removed);
  }
  res.json({ success: true, data: { members, ...(warning ? { warning } : {}) } });
}));

/**
 * POST /api/v1/channels/:id/chore-pmo — 决策 2：登记频道杂务 PMO（find-or-create，幂等）。
 * 登记后，本频道无 token 的派发消息自动归集到杂务 PMO 的 REQ 别名（req-binding 只查不建）。
 */
router.post('/:id/chore-pmo', requireAuth(), requireNotGuest(), handle(async (req, res) => {
  const channel = await channelService.getOrThrow(req.params.id, `Channel not found: ${req.params.id}`);
  try {
    const project = await projectService.ensureChoreProject(channel.id, channel.name);
    res.status(201).json({ success: true, data: project });
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    logger.warn('[Channel] ensure chore PMO failed', { channelId: req.params.id, error: msg });
    res.status(500).json({ success: false, error: msg });
  }
}));

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task (AC-E1)
router.post('/:id/messages/:messageId/convert-to-task', requireAuth(), requireNotGuest(), async (req, res) => {
  const { id: channelId, messageId } = req.params;
  const { title, description, assigneeId, projectPath, workspaceId, reqId } = req.body;

  try {
    const workUnit = await convertToTaskService.convert(channelId, messageId, {
      title,
      description,
      assigneeId,
      projectPath,
      workspaceId,
      reqId,
    });
    res.status(201).json({ success: true, data: workUnit });
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    if (msg.includes('not found')) {
      return res.status(404).json({ success: false, error: msg });
    }
    if (msg.includes('already')) {
      return res.status(400).json({ success: false, error: msg });
    }
    throw e;
  }
});

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task/suggest (AC-E2)
router.post('/:id/messages/:messageId/convert-to-task/suggest', requireAuth(), requireNotGuest(), async (req, res) => {
  const { messageId } = req.params;

  try {
    // 1. Get message content（#524 P1-1：路径参数 :id 即频道，按频道直查免全频道扇出）
    const found = await fileStore.getMessageById(messageId, req.params.id);
    if (!found) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    const message = found.message;

    // 2. Get available agents
    const allProfiles = await fileStore.listProfiles({ status: 'active' });
    const agents = allProfiles.map(p => ({ id: p.id, name: p.name, description: p.description }));

    // 3. Get available projects
    const projects = await projectDiscoveryService.discover();

    // 4. Get LLM suggestion
    const suggestion = await convertToTaskService.suggest(
      message.content,
      agents,
      projects.map(p => ({ name: p.name, path: p.path })),
    );

    res.json({ success: true, data: suggestion });
  } catch (error) {
    // Non-blocking: return empty suggestion on error
    logger.warn('[ConvertToTask] Suggest endpoint error (non-blocking)', { error: String(error) });
    res.json({ success: true, data: {} });
  }
});

export default router;

/** <img>/EventSource 无法带 Authorization 头：?token= → header 后走 requireAuth（optionalAuth 同款先例） */
function tokenQueryToHeader(req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}
