// Channel Routes — B1-001/B1-002/B1-009/B1-011
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger, readSddDoc, updateSddFrontmatter } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { routeMessage } from './message-routing.js';
import { projectService } from '../pmo/project.service.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';

const router = Router();

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

// GET /api/v1/channels — list all channels
router.get('/', apiCache(CACHE_CONFIG.medium), async (_req, res) => {
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: 'asc' },
  });
  res.json({ success: true, data: channels });
});

// POST /api/v1/channels — create a new channel (B2-007)
router.post('/', async (req, res) => {
  const { name, type = 'rnd' } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!['rnd', 'decision', 'system'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be rnd, decision, or system' });
  }
  const channelName = name.startsWith('#') ? name.trim() : `#${name.trim()}`;
  try {
    const channel = await prisma.channel.create({ data: { name: channelName, type } });
    logger.info('[Channel] Created', { id: channel.id, name: channelName });
    res.status(201).json({ success: true, data: channel });
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ success: false, error: 'Channel name already exists' });
    throw e;
  }
});

// GET /api/v1/channels/:id — get channel detail
router.get('/:id', async (req, res) => {
  const channel = await prisma.channel.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { ChannelMessage: true } },
    },
  });
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  res.json({ success: true, data: channel });
});

// GET /api/v1/channels/:id/messages — paginated messages
router.get('/:id/messages', async (req, res) => {
  const { before, limit = '50' } = req.query;
  const take = Math.min(Number(limit), 100);

  const where: any = { channelId: req.params.id };
  if (before) {
    where.createdAt = { lt: new Date(before as string) };
  }

  const [messages, total] = await Promise.all([
    prisma.channelMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    }),
    prisma.channelMessage.count({ where: { channelId: req.params.id } }),
  ]);

  const hasMore = messages.length > take;
  if (hasMore) messages.pop();

  res.json({
    success: true,
    data: messages.reverse(), // chronological order
    total,
    hasMore,
  });
});

// POST /api/v1/channels/:id/messages — send a message
router.post('/:id/messages', async (req, res) => {
  const { content, replyToId } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ success: false, error: 'content is required' });
  }

  const channelId = req.params.id;
  const trimmedContent = content.trim();

  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
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
  const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

  // Find or create #研发 as fallback
  let rndChannel = await prisma.channel.findFirst({ where: { type: 'rnd', id: { not: channel.id } } });
  if (!rndChannel) {
    rndChannel = await prisma.channel.create({ data: { name: '#研发', type: 'rnd' } });
  }

  // SP-004: SDD primary for channel migration
  // DB async sync (non-blocking)
  prisma.requirementsDoc.updateMany({
    where: { sourceChannelId: channel.id },
    data: { sourceChannelId: rndChannel.id },
  }).catch((e: unknown) => logger.warn('[Channel] DB migration sync failed (non-blocking)', { error: String(e) }));
  // SDD frontmatters for migrated docs
  try {
    const { listSddDocs } = await import('@dommaker/studio-shared');
    for (const slug of listSddDocs()) {
      const sdd = readSddDoc(slug, 'requirement');
      if (sdd?.meta.sourceChannelId === channel.id) {
        try { updateSddFrontmatter(slug, { sourceChannelId: rndChannel.id, updatedAt: new Date().toISOString() }); } catch { /* non-blocking */ }
      }
    }
  } catch { /* non-blocking */ }

  // Migrate Goals (via context.sourceChannelId) — update context JSON
  const goals = await prisma.workUnit.findMany({
    where: { metadata: { contains: channel.id }, type: 'task', parentId: null },
  });
  for (const goal of goals) {
    const meta = goal.metadata ? JSON.parse(goal.metadata) : {};
    const ctx = meta.context || {};
    if (ctx.sourceChannelId === channel.id) {
      ctx.sourceChannelId = rndChannel.id;
      meta.context = ctx;
      await prisma.workUnit.update({
        where: { id: goal.id },
        data: { metadata: JSON.stringify(meta) },
      });
    }
  }

  // Cascade delete messages + channel
  await prisma.channel.delete({ where: { id: channel.id } });
  logger.info('[Channel] Deleted with fallback', { deletedId: channel.id, fallbackId: rndChannel.id });
  res.json({ success: true, data: { deleted: true, fallbackChannelId: rndChannel.id } });
});

// PUT /api/v1/channels/:id/archive — archive a channel (B1-011)
router.put('/:id/archive', async (req, res) => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

  // Archive by renaming with timestamp suffix
  const archivedName = `${channel.name}-archived-${Date.now()}`;
  await prisma.channel.update({
    where: { id: channel.id },
    data: { name: archivedName },
  });
  logger.info('[Channel] Archived', { channelId: channel.id, oldName: channel.name });
  res.json({ success: true, data: { archived: true, newName: archivedName } });
});

// PUT /api/v1/channels/:id/restore — restore an archived channel (B1-011)
router.put('/:id/restore', async (req, res) => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
  if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
  if (!channel.name.includes('-archived-')) {
    return res.status(400).json({ success: false, error: 'Channel is not archived' });
  }

  const restoredName = channel.name.replace(/-archived-\d+$/, '');
  await prisma.channel.update({
    where: { id: channel.id },
    data: { name: restoredName },
  });
  logger.info('[Channel] Restored', { channelId: channel.id, restoredName });
  res.json({ success: true, data: { restored: true, name: restoredName } });
});

export default router;
