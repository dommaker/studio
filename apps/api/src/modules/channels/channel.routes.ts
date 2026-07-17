// Channel Routes — B1-001/B1-002/B1-009/B1-011
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { logger, readSddDoc, updateSddFrontmatter, FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { routeMessage } from './message-routing.js';
import { projectService } from '../pmo/project.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { ConvertToTaskService } from './convert-to-task.service.js';
import { ProjectDiscoveryService } from '../projects/project-discovery.service.js';

const router = Router();
const fileStore = new FileStore();
const convertToTaskService = new ConvertToTaskService(undefined, fileStore);
const projectDiscoveryService = new ProjectDiscoveryService();

// ─── AC Group Parser ───────────────────────────────────────────────
//
// State machine:
//   OUTSIDE → (## AC Groups) → IN_GROUPS → (### name) → IN_GROUP → (#### heading) → IN_SECTION
//
// Bug fixes (2026-05-21):
//   B1: H2/H3 inside free-text sections (notes/patterns/gotchas) are content, not structure
//   B2: Push currentGroup before nullifying on section exit
//   B3: Parse inline dep name from "#### 依赖: group-name"
//   B4: Code fence awareness — headings inside ``` blocks are ignored
//   B5: Loose checkbox fallback when no ACs found via headings
//   B6: Legacy "Files:"/"Depends on:" only fire in their respective sections
//
function parseAcGroupsFromMarkdown(content: string): Array<{
  id: string; acs: string[]; files: string[]; dependencies: string[];
  implementationNotes: string; codePatterns: string[]; gotchas: string[];
  modelTier?: string; modelTierReason?: string;
}> {
  const groups: Array<{
    id: string; acs: string[]; files: string[]; dependencies: string[];
    implementationNotes: string; codePatterns: string[]; gotchas: string[];
    modelTier?: string; modelTierReason?: string;
  }> = [];
  const lines = content.split('\n');

  type Section = 'acs' | 'notes' | 'patterns' | 'gotchas' | 'files' | 'deps';
  const FREE_TEXT_SECTIONS: Set<Section> = new Set(['notes', 'patterns', 'gotchas']);

  let currentGroup: ReturnType<typeof parseAcGroupsFromMarkdown>[0] | null = null;
  let currentSection: Section | null = null;
  let inAcGroups = false;
  let inCodeFence = false;

  for (const line of lines) {
    // B4: code fence tracking — ignore everything inside code blocks
    if (/^```/.test(line)) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) {
      // Still capture code lines into notes if we're in that section
      if (currentSection === 'notes' && currentGroup) {
        currentGroup.implementationNotes += '\n' + line;
      }
      continue;
    }

    // MODEL_TIER HTML comment: <!-- MODEL_TIER {"tier":"fast","reason":"..."} -->
    const modelTierMatch = line.match(/<!--\s*MODEL_TIER\s+(\{.+\})\s*-->/);
    if (modelTierMatch && currentGroup) {
      try {
        const mt = JSON.parse(modelTierMatch[1]);
        currentGroup.modelTier = mt.tier;
        currentGroup.modelTierReason = mt.reason || '';
      } catch { /* ignore malformed */ }
      continue;
    }

    const inFreeText = currentSection !== null && FREE_TEXT_SECTIONS.has(currentSection);

    // ── H2: document-level section boundary ──
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      const h2Title = h2Match[1].trim();
      // B1: H2 inside free text is content, not structure
      if (inFreeText && currentGroup) {
        currentGroup.implementationNotes += '\n' + line;
        continue;
      }
      const isAcGroupsHeader = h2Title.includes('AC Group') || h2Title.includes('AC组');
      if (inAcGroups && !isAcGroupsHeader) {
        // B2: push before exit
        if (currentGroup && currentGroup.acs.length > 0) groups.push(currentGroup);
        currentGroup = null;
        currentSection = null;
        inAcGroups = false;
      }
      if (isAcGroupsHeader) inAcGroups = true;
      continue;
    }

    // ── H3: AC group boundary ──
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      if (!inAcGroups) continue;
      // B1: H3 inside free text is content
      if (inFreeText && currentGroup) {
        currentGroup.implementationNotes += '\n' + line;
        continue;
      }
      const h3Title = h3Match[1].trim();
      // Numbered implementation steps are NOT AC groups
      if (/^\d+[\.\s]/.test(h3Title)) {
        if (currentGroup && currentGroup.acs.length > 0) groups.push(currentGroup);
        currentGroup = null;
        currentSection = null;
        inAcGroups = false;
        continue;
      }
      if (currentGroup && currentGroup.acs.length > 0) groups.push(currentGroup);
      currentGroup = { id: h3Title, acs: [], files: [], dependencies: [], implementationNotes: '', codePatterns: [], gotchas: [] };
      currentSection = null;
      continue;
    }

    if (!currentGroup) continue;

    // ── H4: section switch within current group ──
    const h4Match = line.match(/^####\s+(.+)/);
    if (h4Match) {
      const title = h4Match[1].trim();
      if (title.includes('验收标准')) currentSection = 'acs';
      else if (title.includes('实现指南')) currentSection = 'notes';
      else if (title.includes('参考模式')) currentSection = 'patterns';
      else if (title.includes('注意事项')) currentSection = 'gotchas';
      else if (title.includes('涉及文件')) currentSection = 'files';
      else if (title.includes('依赖')) {
        currentSection = 'deps';
        // B3: parse inline dep name from "#### 依赖: group-name"
        const inlineDep = title.match(/依赖[：:]\s*(.+)/);
        if (inlineDep) {
          for (const d of inlineDep[1].split(/[,，\s]+/).filter(Boolean)) {
            currentGroup.dependencies.push(d);
          }
        }
      }
      else currentSection = null;
      continue;
    }

    // ── Content parsing ──
    switch (currentSection) {
      case 'acs': {
        const acMatch = line.match(/^-\s*\[([ x])\]\s+(.+)/);
        if (acMatch) currentGroup.acs.push(acMatch[2].trim());
        break;
      }
      case 'notes':
        if (line.trim()) {
          currentGroup.implementationNotes += (currentGroup.implementationNotes ? '\n' : '') + line.trim();
        }
        break;
      case 'patterns': {
        const pMatch = line.match(/^-\s+(.+)/);
        if (pMatch) currentGroup.codePatterns.push(pMatch[1].trim());
        break;
      }
      case 'gotchas': {
        const gMatch = line.match(/^-\s+(.+)/);
        if (gMatch) currentGroup.gotchas.push(gMatch[1].trim());
        break;
      }
      case 'files': {
        const fMatch = line.match(/^-\s+(.+)/);
        if (fMatch) currentGroup.files.push(fMatch[1].trim());
        // B6: legacy "Files: a, b" — only in files section
        const legacyFiles = line.match(/^Files:\s*(.+)/);
        if (legacyFiles) currentGroup.files = legacyFiles[1].split(',').map(f => f.trim());
        break;
      }
      case 'deps': {
        // B6: only parse structured "- name" or inline "Depends on:" in deps section
        const depItem = line.match(/^-\s+(.+)/);
        if (depItem) {
          currentGroup.dependencies.push(depItem[1].trim());
        } else {
          const legacyDeps = line.match(/Depends on:\s*(.+)/);
          if (legacyDeps) {
            currentGroup.dependencies = legacyDeps[1].split(',').map(d => d.trim());
          }
        }
        break;
      }
    }
  }

  // Finalize last group
  if (currentGroup && currentGroup.acs.length > 0) groups.push(currentGroup);

  // B5: fallback — scan for loose checkboxes if no ACs found via headings
  if (groups.length === 0) {
    const acLines: string[] = [];
    for (const line of lines) {
      const m = line.match(/^-\s*\[([ x])\]\s+(.+)/);
      if (m) acLines.push(m[2].trim());
    }
    if (acLines.length > 0) {
      groups.push({
        id: 'implementation', acs: acLines, files: [], dependencies: [],
        implementationNotes: '', codePatterns: [], gotchas: [],
      });
    }
  }

  // Absolute fallback: nothing found at all
  if (groups.length === 0) {
    groups.push({
      id: 'implementation',
      acs: ['Complete the implementation as described'],
      files: [], dependencies: [],
      implementationNotes: '', codePatterns: [], gotchas: [],
    });
  }
  return groups;
}

// GET /api/v1/channels — list all non-archived channels
router.get('/', apiCache(CACHE_CONFIG.medium), async (_req, res) => {
  const channels = await fileStore.listChannels({ excludeArchived: true });
  res.json({ success: true, data: channels });
});

// POST /api/v1/channels — create a new channel (B2-007)
// Also supports creating initial agents: { agents: [{ name, description? }] }
router.post('/', async (req, res) => {
  const { name, type = 'rnd', members, agents } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!['rnd', 'decision', 'system'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be rnd, decision, or system' });
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
      defaultPath: null,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
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

// GET /api/v1/channels/:id/messages — paginated messages
router.get('/:id/messages', async (req, res) => {
  const { before, limit = '50' } = req.query;
  const take = Math.min(Number(limit), 100);

  let messages = await fileStore.queryMessages(req.params.id);
  if (before) {
    const beforeTime = new Date(before as string).getTime();
    messages = messages.filter(m => new Date(m.createdAt).getTime() < beforeTime);
  }
  const total = messages.length;

  // Sort descending, take + 1 for hasMore
  messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const hasMore = messages.length > take;
  if (hasMore) messages.pop();

  // 解析 meta JSON，转换 createdAt 类型
  const data = messages.reverse().map(m => ({
    ...m,
    meta: typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta,
    createdAt: new Date(m.createdAt),
  }));

  res.json({ success: true, data, total, hasMore });
});

// POST /api/v1/channels/:id/messages — send a message
router.post('/:id/messages', async (req, res) => {
  const { content, replyToId } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ success: false, error: 'content is required' });
  }

  const channelId = req.params.id;
  const trimmedContent = content.trim();

  const channel = await fileStore.getChannel(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, error: 'Channel not found' });
  }

  const message = await routeMessage(
    channelId,
    trimmedContent,
    replyToId || undefined,
  );

  res.status(201).json({ success: true, data: message });
});

// DELETE /api/v1/channels/:id — delete channel (B2-012: Goal fallback to #研发)
router.delete('/:id', async (req, res) => {
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

  // SDD frontmatters for migrated docs (non-blocking)
  try {
    const { listSddDocs } = await import('@dommaker/studio-shared');
    for (const slug of await listSddDocs()) {
      const sdd = await readSddDoc(slug, 'requirement');
      if (sdd?.meta.sourceChannelId === channel.id) {
        try { await updateSddFrontmatter(slug, { sourceChannelId: rndChannel.id, updatedAt: new Date().toISOString() }); } catch { /* non-blocking */ }
      }
    }
  } catch { /* non-blocking */ }

  // Migrate WorkUnits via FileStore (context.sourceChannelId in metadata)
  const allWus = await fileStore.getIndex();
  const goals = allWus.filter(s => s.type === 'task' && s.parentId === null && s.metadata?.includes(channel.id));
  for (const goal of goals) {
    const meta = goal.metadata ? JSON.parse(goal.metadata) : {};
    const ctx = meta.context || {};
    if (ctx.sourceChannelId === channel.id) {
      ctx.sourceChannelId = rndChannel.id;
      meta.context = ctx;
      await fileStore.upsertSnapshot({ ...goal, metadata: JSON.stringify(meta), updatedAt: new Date().toISOString() });
    }
  }

  // Delete channel
  await fileStore.deleteChannel(channel.id);
  logger.info('[Channel] Deleted with fallback', { deletedId: channel.id, fallbackId: rndChannel.id });
  res.json({ success: true, data: { deleted: true, fallbackChannelId: rndChannel.id } });
});

// PUT /api/v1/channels/:id/archive — archive a channel (B1-011)
router.put('/:id/archive', async (req, res) => {
  const channel = await fileStore.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

  // Archive by renaming with timestamp suffix
  const archivedName = `${channel.name}-archived-${Date.now()}`;
  await fileStore.updateChannel(channel.id, { name: archivedName });
  logger.info('[Channel] Archived', { channelId: channel.id, oldName: channel.name });
  res.json({ success: true, data: { archived: true, newName: archivedName } });
});

// PUT /api/v1/channels/:id/restore — restore an archived channel (B1-011)
router.put('/:id/restore', async (req, res) => {
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
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, defaultWorkspaceId, defaultPath } = req.body;
  try {
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (defaultWorkspaceId !== undefined) data.defaultWorkspaceId = defaultWorkspaceId;
    if (defaultPath !== undefined) data.defaultPath = defaultPath;
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
router.patch('/:id/members', async (req, res) => {
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

// POST /api/v1/channels/:id/messages/:messageId/convert-to-task (AC-E1)
router.post('/:id/messages/:messageId/convert-to-task', async (req, res) => {
  const { id: channelId, messageId } = req.params;
  const { title, description, assigneeId, projectPath } = req.body;

  try {
    const workUnit = await convertToTaskService.convert(channelId, messageId, {
      title,
      description,
      assigneeId,
      projectPath,
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
router.post('/:id/messages/:messageId/convert-to-task/suggest', async (req, res) => {
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
