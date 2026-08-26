// Channel Routes — B1-001/B1-002/B1-009/B1-011
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { logger, FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { routeMessage } from './message-routing.js';
import { projectService } from '../pmo/project.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';
import { ConvertToTaskService } from './convert-to-task.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { ProjectDiscoveryService } from '../projects/project-discovery.service.js';
import { getWorkspaceRecord } from '../workspaces/workspace-store.js';
import { getChannelFileVocabulary } from './file-ref-vocabulary.js';
import { deriveChannelCurrentPmo } from './current-pmo.js';

const router = Router();
const fileStore = new FileStore();
const convertToTaskService = new ConvertToTaskService(fileStore);
const workUnitService = new WorkUnitService(fileStore);
const projectDiscoveryService = new ProjectDiscoveryService();

// GET /api/v1/channels — list all non-archived channels
router.get('/', apiCache(CACHE_CONFIG.medium), async (_req, res) => {
  const channels = await fileStore.listChannels({ excludeArchived: true });
  res.json({ success: true, data: channels });
});

// POST /api/v1/channels — create a new channel (B2-007)
// Also supports creating initial agents: { agents: [{ name, description? }] }
router.post('/', requireAuth(), requireNotGuest(), async (req, res) => {
  const { name, type = 'rnd', members, agents, defaultPipeline, defaultPath } = req.body;
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
  // AC-6.2: validate defaultPipeline items are active AgentProfile names
  let pipelineValue: string[] | undefined;
  if (defaultPipeline !== undefined) {
    const validated = await validateDefaultPipeline(fileStore, defaultPipeline);
    if (!validated.ok) {
      return res.status(400).json({ success: false, error: validated.error });
    }
    pipelineValue = validated.value;
  }
  const channelName = name.startsWith('#') ? name.trim() : `#${name.trim()}`;
  try {
    // Check duplicate name (FileStore has no unique constraint)
    const existing = await fileStore.listChannels({ name: channelName });
    if (existing.length > 0) {
      return res.status(409).json({ success: false, error: 'Channel name already exists' });
    }
    // Create channel first
    const now = new Date().toISOString();
    const channel = {
      id: randomUUID(),
      name: channelName,
      type,
      defaultWorkspaceId: null,
      defaultPath: defaultPathValue,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      ...(pipelineValue !== undefined ? { defaultPipeline: pipelineValue } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await fileStore.createChannel(channel);

    // Create initial agents if provided
    const createdAgentIds: string[] = [];
    if (Array.isArray(agents) && agents.length > 0) {
      for (const agent of agents) {
        if (!agent.name || typeof agent.name !== 'string') continue;
        try {
          const profile = await createAgentWithFileStore(fileStore, agent.name.trim(), agent.description, channel.id, agent.provider);
          createdAgentIds.push(profile.id);
        } catch (agentErr: any) {
          // Skip duplicate agent names, continue with others
          if (!agentErr?.message?.includes('Unique constraint')) {
            logger.warn('[Channel] Failed to create agent', { agent: agent.name, error: String(agentErr) });
          }
        }
      }

      // Update channel members with created agent IDs
      if (createdAgentIds.length > 0) {
        await fileStore.updateChannel(channel.id, { members: JSON.stringify(createdAgentIds) });
      }
    }

    // Also include explicitly provided member IDs
    if (Array.isArray(members) && members.length > 0) {
      const allMembers = [...new Set([...createdAgentIds, ...members])];
      await fileStore.updateChannel(channel.id, { members: JSON.stringify(allMembers) });
    }

    // Reload channel to get final members
    const finalChannel = await fileStore.getChannel(channel.id);
    logger.info('[Channel] Created', { id: channel.id, name: channelName, agents: createdAgentIds.length });
    res.status(201).json({ success: true, data: finalChannel });
  } catch (e: any) {
    throw e;
  }
});

// GET /api/v1/channels/:id — get channel detail
router.get('/:id', async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  const messageCount = await fileStore.countMessages(req.params.id);
  res.json({ success: true, data: { ...channel, _count: { ChannelMessage: messageCount } } });
});

// GET /api/v1/channels/:id/current-pmo — #272（决策 #251 Q6）：顶栏「当前 PMO」chip
// 派生概念不落库：最近挂接 REQ 所属 PMO → 杂务 PMO 反推 → null（见 current-pmo.ts）。
router.get('/:id/current-pmo', async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  const pmo = await deriveChannelCurrentPmo(req.params.id);
  res.json({ success: true, data: pmo });
});

// GET /api/v1/channels/:id/messages — paginated messages
// #319：before = 锚点消息 id 游标（原 timestamp 游标同毫秒撞车会漏/重）；分页半下沉到存储层（queryMessagesPage 切片）
router.get('/:id/messages', async (req, res) => {
  const { before, limit = '50' } = req.query;
  const take = Math.min(Number(limit), 100);

  const page = await fileStore.queryMessagesPage(req.params.id, {
    before: typeof before === 'string' && before ? before : undefined,
    limit: take,
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
router.get('/:id/file-vocabulary', async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  try {
    const vocabulary = await getChannelFileVocabulary(req.params.id);
    res.json({ success: true, data: vocabulary });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[Channel] file vocabulary failed', { channelId: req.params.id, error: msg });
    res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/v1/channels/:id/messages — send a message
router.post('/:id/messages', requireAuth(), requireNotGuest(), async (req, res) => {
  const { content, replyToId, workspaceId, reqId, files } = req.body;
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

  const channel = await fileStore.getChannel(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, error: 'Channel not found' });
  }

  // P0 修复 6: traceId — 复用 audit 中间件落在 req 上的 requestId（同一次 HTTP 请求同值），
  // 没有则新建（如单测直连路由）；@mention 建 WU 时写入 metadata.traceId。
  const traceId = (req as any).requestId ?? randomUUID();

  // F6: 调用方可显式指定 workspaceId（缺省走频道默认工程）
  const message = await routeMessage(
    channelId,
    trimmedContent,
    replyToId || undefined,
    undefined,
    {
      workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined,
      // REQ 需求编号（vision §5.3）：调用方可显式指定（缺省走 #REQ-XXXX token / 自动新建）
      reqId: typeof reqId === 'string' && reqId ? reqId : undefined,
      traceId,
      // #281: @文件引用（路由层做存在性校验 + 剔除播报）
      files: files as { repo: string; path: string }[] | undefined,
    },
  );

  res.status(201).json({ success: true, data: message });
});

// DELETE /api/v1/channels/:id — delete channel (B2-012: Goal fallback to #研发)
router.delete('/:id', requireAuth(), requireNotGuest(), async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

  // Find or create #研发 as fallback
  let rndChannels = await fileStore.listChannels({ type: 'rnd' });
  let rndChannel = rndChannels.find(c => c.id !== channel.id);
  if (!rndChannel) {
    const rndId = randomUUID();
    const now = new Date().toISOString();
    rndChannel = { id: rndId, name: '#研发', type: 'rnd', defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: now, updatedAt: now };
    await fileStore.createChannel(rndChannel);
  }

  // Migrate WorkUnits via WorkUnitService (context.sourceChannelId in metadata)
  // 存储归属收敛：匹配（字段相等）与写入（事件+快照）均由 WorkUnitService.rebindSourceChannel 负责
  await workUnitService.rebindSourceChannel(channel.id, rndChannel.id);

  // Delete channel
  await fileStore.deleteChannel(channel.id);
  logger.info('[Channel] Deleted with fallback', { deletedId: channel.id, fallbackId: rndChannel.id });
  res.json({ success: true, data: { deleted: true, fallbackChannelId: rndChannel.id } });
});

// PUT /api/v1/channels/:id/archive — archive a channel (B1-011)
router.put('/:id/archive', requireAuth(), requireNotGuest(), async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

  // Archive by renaming with timestamp suffix
  const archivedName = `${channel.name}-archived-${Date.now()}`;
  await fileStore.updateChannel(channel.id, { name: archivedName });
  logger.info('[Channel] Archived', { channelId: channel.id, oldName: channel.name });
  res.json({ success: true, data: { archived: true, newName: archivedName } });
});

// PUT /api/v1/channels/:id/restore — restore an archived channel (B1-011)
router.put('/:id/restore', requireAuth(), requireNotGuest(), async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  if (!channel.name.includes('-archived-')) {
    return res.status(400).json({ success: false, error: 'Channel is not archived' });
  }

  const restoredName = channel.name.replace(/-archived-\d+$/, '');
  await fileStore.updateChannel(channel.id, { name: restoredName });
  logger.info('[Channel] Restored', { channelId: channel.id, restoredName });
  res.json({ success: true, data: { restored: true, name: restoredName } });
});

// PATCH /api/v1/channels/:id — update channel settings
router.patch('/:id', requireAuth(), requireNotGuest(), async (req, res) => {
  const { id } = req.params;
  const { name, defaultWorkspaceId, defaultPath, defaultPipeline, defaultProfileId } = req.body;
  try {
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
    // AC-6.2: validate defaultPipeline items are active AgentProfile names
    if (defaultPipeline !== undefined) {
      const validated = await validateDefaultPipeline(fileStore, defaultPipeline);
      if (!validated.ok) {
        return res.status(400).json({ success: false, error: validated.error });
      }
      data.defaultPipeline = validated.value;
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
    await fileStore.updateChannel(id, data as Partial<import('@dommaker/studio-shared').ChannelData>);
    const updated = await fileStore.getChannel(id);
    if (!updated) return res.status(404).json({ success: false, error: 'Channel not found' });
    res.json({ success: true, data: updated });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }
    throw e;
  }
});

// PATCH /api/v1/channels/:id/members — update channel members (AC-B2)
router.patch('/:id/members', requireAuth(), requireNotGuest(), async (req, res) => {
  const { add, remove } = req.body;
  try {
    const members = await updateChannelMembers(req.params.id, { add, remove });
    res.json({ success: true, data: { members } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      return res.status(404).json({ success: false, error: msg });
    }
    throw e;
  }
});

/**
 * POST /api/v1/channels/:id/chore-pmo — 决策 2：登记频道杂务 PMO（find-or-create，幂等）。
 * 登记后，本频道无 token 的派发消息自动归集到杂务 PMO 的 REQ 别名（req-binding 只查不建）。
 */
router.post('/:id/chore-pmo', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const channel = await fileStore.getChannel(req.params.id);
    if (!channel) {
      return res.status(404).json({ success: false, error: `Channel not found: ${req.params.id}` });
    }
    const project = await projectService.ensureChoreProject(channel.id, channel.name);
    res.status(201).json({ success: true, data: project });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[Channel] ensure chore PMO failed', { channelId: req.params.id, error: msg });
    res.status(500).json({ success: false, error: msg });
  }
});

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
    const msg = e instanceof Error ? e.message : String(e);
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
    // 1. Get message content
    const found = await fileStore.getMessageById(messageId);
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

/** Create an agent profile using FileStore (used during channel creation). */
async function createAgentWithFileStore(fs: FileStore, name: string, description: string | null, channelId: string, provider?: string): Promise<{ id: string }> {
  const { randomUUID } = await import('crypto');
  // Check name uniqueness
  const all = await fs.listProfiles();
  const existing = all.find(p => p.name === name);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const profile = {
    id: randomUUID(),
    name,
    description: description ?? null,
    channels: JSON.stringify([channelId]),
    provider: provider ?? null,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
  await fs.createProfile(profile);
  return profile;
}

/** Update channel members: add/remove agent IDs (idempotent). Returns updated members array. */
export async function updateChannelMembers(
  channelId: string,
  ops: { add?: string[]; remove?: string[] },
): Promise<string[]> {
  const channel = await fileStore.getChannel(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found`);

  const current: string[] = JSON.parse(channel.members);
  const addIds: string[] = ops.add ?? [];
  const removeIds: string[] = ops.remove ?? [];

  const updated = [...new Set([...current, ...addIds])].filter(id => !removeIds.includes(id));

  await fileStore.updateChannel(channelId, { members: JSON.stringify(updated) });

  return updated;
}

/**
 * F6: 归一化 + 校验 defaultWorkspaceId（channel PATCH 用）。
 * '' / null / 非字符串 → null（清除默认工程）；非空字符串须对应已注册 workspace。
 */
export async function validateDefaultWorkspaceId(
  value: unknown,
): Promise<{ ok: boolean; value: string | null; error?: string }> {
  const wsId = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (wsId && !(await getWorkspaceRecord(wsId))) {
    return { ok: false, value: null, error: `Workspace not found: ${wsId}` };
  }
  return { ok: true, value: wsId };
}

/**
 * AC-6.2: validate defaultPipeline items are active AgentProfile names.
 * - undefined -> ok, value=undefined (skip update)
 * - non-array -> reject
 * - each item must be string matching an active AgentProfile.name
 * - empty array allowed (clears pipeline)
 */
export async function validateDefaultPipeline(
  fs: FileStore,
  value: unknown,
): Promise<{ ok: boolean; value?: string[]; error?: string }> {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'defaultPipeline must be an array' };
  }
  if (value.length === 0) return { ok: true, value: [] };
  const activeProfiles = await fs.listProfiles({ status: 'active' });
  const activeNames = new Set(activeProfiles.map(p => p.name));
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, error: `defaultPipeline item must be string: ${String(item)}` };
    }
    if (!activeNames.has(item)) {
      return { ok: false, error: `AgentProfile not found or not active: ${item}` };
    }
  }
  return { ok: true, value: value as string[] };
}
