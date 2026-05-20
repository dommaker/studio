// Channel Routes — B1-001/B1-002/B1-009/B1-011
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { goalService } from '../goals/goal.service.js';
import { KnowledgeStore, KnowledgeIngest } from '@dommaker/harness';

const router = Router();

// Parse AC Groups from RequirementsDoc Markdown content (enhanced: implementationNotes/codePatterns/gotchas)
function parseAcGroupsFromMarkdown(content: string): Array<{
  id: string; acs: string[]; files: string[]; dependencies: string[];
  implementationNotes: string; codePatterns: string[]; gotchas: string[];
}> {
  const groups: Array<{
    id: string; acs: string[]; files: string[]; dependencies: string[];
    implementationNotes: string; codePatterns: string[]; gotchas: string[];
  }> = [];
  const lines = content.split('\n');
  let currentGroup: ReturnType<typeof parseAcGroupsFromMarkdown>[0] | null = null;
  let currentSection: string | null = null;

  for (const line of lines) {
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { id: h3Match[1].trim(), acs: [], files: [], dependencies: [], implementationNotes: '', codePatterns: [], gotchas: [] };
      currentSection = null;
      continue;
    }

    if (!currentGroup) continue;

    const h4Match = line.match(/^####\s+(.+)/);
    if (h4Match) {
      const title = h4Match[1].trim();
      if (title.includes('验收标准')) currentSection = 'acs';
      else if (title.includes('实现指南')) currentSection = 'notes';
      else if (title.includes('参考模式')) currentSection = 'patterns';
      else if (title.includes('注意事项')) currentSection = 'gotchas';
      else if (title.includes('涉及文件')) currentSection = 'files';
      else if (title.includes('依赖')) currentSection = 'deps';
      else currentSection = null;
      continue;
    }

    switch (currentSection) {
      case 'acs': {
        const acMatch = line.match(/^-\s*\[([ x])\]\s+(.+)/);
        if (acMatch) currentGroup.acs.push(acMatch[2].trim());
        break;
      }
      case 'notes':
        if (line.trim()) currentGroup.implementationNotes += (currentGroup.implementationNotes ? '\n' : '') + line.trim();
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
        break;
      }
      case 'deps': {
        const depMatch = line.match(/([a-zA-Z0-9_-]+)/g);
        if (depMatch) currentGroup.dependencies.push(...depMatch);
        break;
      }
    }

    // Legacy fallback patterns
    const legacyFiles = line.match(/^Files:\s*(.+)/);
    if (legacyFiles) currentGroup.files = legacyFiles[1].split(',').map(f => f.trim());
    const legacyDeps = line.match(/Depends on:\s*(.+)/);
    if (legacyDeps) currentGroup.dependencies = legacyDeps[1].split(',').map(d => d.trim());
  }
  if (currentGroup) groups.push(currentGroup);

  if (groups.length === 0) {
    groups.push({
      id: 'implementation',
      acs: ['Complete the implementation as described'],
      files: [],
      dependencies: [],
      implementationNotes: '',
      codePatterns: [],
      gotchas: [],
    });
  }

  return groups;
}

// GET /api/v1/channels — list all channels
router.get('/', async (_req, res) => {
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

  const message = await channelMessageService.createHumanMessage(
    channelId,
    trimmedContent,
    replyToId || undefined,
  );

  // @Analyst trigger detection (≥30 chars, case-insensitive)
  const isAnalystTrigger =
    trimmedContent.length >= 30 &&
    /@analyst/i.test(trimmedContent);

  if (isAnalystTrigger) {
    // Fire-and-forget: don't block the response
    import('./analyst-trigger.service.js')
      .then(({ analystTriggerService }) =>
        analystTriggerService.trigger(channelId, message.id, trimmedContent)
      )
      .catch(err =>
        logger.error('[Channel] Analyst trigger failed', { error: String(err) })
      );

    logger.info('[Channel] @Analyst trigger detected', { channelId, messageId: message.id });
  }

  // @KK retract trigger detection (B1-010): @KK retract <skill-name>
  const kkRetractMatch = trimmedContent.match(/@KK\s+retract\s+(.+)/i);
  if (kkRetractMatch) {
    const skillName = kkRetractMatch[1].trim();
    // Fire-and-forget: find skill by name and trigger retract
    (async () => {
      try {
        const skill = await prisma.skill.findFirst({
          where: { name: { contains: skillName }, status: 'published' },
        });
        if (skill) {
          // Call retract via the skill-proposal-routes logic
          const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
          await prisma.skill.update({
            where: { id: skill.id },
            data: { status: 'under_review' },
          });
          if (sysChannel) {
            await channelMessageService.createCardMessage(
              sysChannel.id,
              'KK',
              `⚠️ **撤回确认**: Skill \`${skill.name}\` [${skill.category || '未分类'}]\n\n${skill.description || '无描述'}\n\n确认将此 Skill 标记为废弃？`,
              'retract_confirm',
              { skillId: skill.id, skillName: skill.name },
            );
          }
          logger.info('[Channel] @KK retract triggered', { skillId: skill.id, skillName: skill.name });
        } else {
          await channelMessageService.createAgentMessage(
            channelId,
            'KK',
            `未找到已发布的 Skill "${skillName}"。请确认名称是否正确。`,
          );
        }
      } catch (err) {
        logger.error('[Channel] @KK retract failed', { error: String(err) });
      }
    })();
  }

  res.status(201).json({ success: true, data: { ...message, analystTriggered: isAnalystTrigger } });
});

// POST /api/v1/channels/:channelId/messages/:messageId/actions — card action buttons
router.post('/:channelId/messages/:messageId/actions', async (req, res) => {
  const { action } = req.body;
  if (!['start_execution', 'modify', 'continue_discussion', 'knowledge_confirm', 'knowledge_reject', 'retract_confirm', 'retract_reject', 'auditor_apply_confirm', 'auditor_apply_reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }

  const message = await prisma.channelMessage.findUnique({
    where: { id: req.params.messageId },
  });
  if (!message) return res.status(404).json({ success: false, error: 'Message not found' });

  const meta = JSON.parse(message.meta || '{}');

  if (action === 'start_execution') {
    const docId = meta.requirementsDocId || meta.cardData?.requirementsDocId;
    if (docId) {
      const doc = await prisma.requirementsDoc.findUnique({ where: { id: docId } });
      if (!doc) return res.status(404).json({ success: false, error: 'RequirementsDoc not found' });

      // Find or create default company
      let company = await prisma.company.findFirst();
      if (!company) {
        company = await prisma.company.create({ data: { name: 'Default' } });
      }

      // Parse AC Groups from RequirementsDoc content (Markdown → structured)
      const acGroups = parseAcGroupsFromMarkdown(doc.content);
      const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));

      // Assess risk (B1-009): check for sensitive keywords in ACs
      const allAcs = acGroups.flatMap(g => g.acs).join(' ');
      const risks: string[] = [];
      if (/auth|login|password|token|oauth|jwt|session|credential/i.test(allAcs)) risks.push('auth');
      if (/database|schema|migration|prisma|sql|table|index/i.test(allAcs)) risks.push('schema_change');
      if (/api|endpoint|route|middleware|webhook/i.test(allAcs)) risks.push('api_change');
      if (/payment|billing|transaction|balance|money/i.test(allAcs)) risks.push('financial');

      // B1-002: Create Goal + GoalPlan(approved) + GoalExecutions(pending) via GoalService
      // This creates the GoalPlan that GoalScheduler.getExecutableSteps() requires
      const result = await goalService.createGoalFromChannelDoc({
        title: doc.title,
        summary: doc.content.slice(0, 200),
        acGroups,
        companyId: company.id,
        sourceChannelId: req.params.channelId,
        requirementsDocId: docId,
        projectId: doc.projectId || undefined,
        risks,
      });

      // Update RequirementsDoc
      await prisma.requirementsDoc.update({
        where: { id: docId },
        data: { status: 'confirmed', goalId: result.goalId },
      });

      meta.status = 'executing';
      meta.goalId = result.goalId;

      // Post progress message
      const riskNote = risks.length > 0
        ? `\n⚠️ 风险标注: ${risks.join(', ')}`
        : '';
      await channelMessageService.createAgentMessage(
        req.params.channelId,
        'Executor',
        `✅ 已创建 Goal \`${result.goalId.slice(0, 8)}\`，${result.stepCount} 个执行组排队中。${riskNote}`,
        { meta: { goalId: result.goalId, status: 'queued', risks } },
      );

      logger.info('[Channel] Goal created from RequirementsDoc', {
        docId, goalId: result.goalId, stepCount: result.stepCount, risks,
      });
    }
  } else if (action === 'modify') {
    meta.status = 'needs_revision';
    await channelMessageService.createAgentMessage(
      req.params.channelId,
      'Analyst',
      '请说明需要修改的内容，我会重新分析。',
      { meta: { status: 'awaiting_input' } },
    );
  } else if (action === 'continue_discussion') {
    meta.status = 'discussing';
    await channelMessageService.createAgentMessage(
      req.params.channelId,
      'Analyst',
      '请补充更多上下文或具体问题，我会继续分析。',
      { meta: { status: 'awaiting_input' } },
    );
  } else if (action === 'knowledge_confirm') {
    // B1-008: KK @human 确认 — 人点击"确认"后写入知识库
    const cardData = meta.cardData || {};
    const entries = cardData.entries as Array<{ type: string; title: string; content: string; tags: string[] }> | undefined;
    const taskId = cardData.taskId as string | undefined;
    const projectId = cardData.projectId as string | undefined;
    const source = cardData.source as string | undefined;

    if (entries?.length && taskId) {
      const store = new KnowledgeStore();
      const ingest = new KnowledgeIngest(store);

      for (const entry of entries) {
        // harness 文件存储
        ingest.ingestEntry(
          { type: entry.type as any, title: entry.title, content: entry.content, tags: entry.tags, projects: [projectId || taskId] },
          { source: source || `task:${taskId}`, layer: 'project', maturity: 'draft', tags: entry.tags, projects: [projectId || taskId] },
        );

        // Prisma Document 双写
        try {
          if (projectId) {
            const project = await prisma.project.findUnique({ where: { id: projectId }, select: { companyId: true } });
            if (project?.companyId) {
              await prisma.document.create({
                data: {
                  projectId,
                  companyId: project.companyId,
                  type: entry.type as any,
                  title: entry.title,
                  content: entry.content,
                  status: 'active',
                  version: 1,
                  tags: JSON.stringify(entry.tags || []),
                },
              });
            }
          }
        } catch (docErr) {
          logger.warn('[Channel] Document write failed for confirmed knowledge', { error: String(docErr) });
        }
      }

      meta.status = 'confirmed';
      logger.info('[Channel] Knowledge confirmed and written', { taskId, entryCount: entries.length });

      await channelMessageService.createAgentMessage(
        req.params.channelId,
        'KK',
        `✅ 已确认入库 ${entries.length} 条知识：${entries.map(e => e.title).join(', ')}`,
        { meta: { status: 'done' } },
      );
    }
  } else if (action === 'knowledge_reject') {
    // B1-008: 人点击"拒绝"后丢弃知识
    const cardData = meta.cardData || {};
    const entries = cardData.entries as Array<{ title: string }> | undefined;

    meta.status = 'rejected';
    logger.info('[Channel] Knowledge rejected', { entryCount: entries?.length });

    await channelMessageService.createAgentMessage(
      req.params.channelId,
      'KK',
      `已丢弃 ${entries?.length || 0} 条知识。${entries?.map(e => e.title).join(', ') || ''}`,
      { meta: { status: 'done' } },
    );
  } else if (action === 'retract_confirm') {
    // B1-010: 人确认撤回 Skill → deprecated
    const cardData = meta.cardData || {};
    const skillId = cardData.skillId as string | undefined;
    const skillName = cardData.skillName as string | undefined;

    if (skillId) {
      await prisma.skill.update({
        where: { id: skillId },
        data: { status: 'deprecated' },
      });

      meta.status = 'deprecated';
      logger.info('[Channel] Skill retract confirmed', { skillId, skillName });

      await channelMessageService.createAgentMessage(
        req.params.channelId,
        'KK',
        `✅ Skill \`${skillName || skillId}\` 已标记为废弃。`,
        { meta: { status: 'done' } },
      );
    }
  } else if (action === 'auditor_apply_confirm') {
    // B3-005: 人确认审计建议 → 执行高风险建议
    const cardData = meta.cardData || {};
    const suggestions = cardData.suggestions as Array<{
      type: string; risk: string; skillId?: string; skillName?: string;
      agentType?: string; detail: string; data?: Record<string, unknown>;
    }> | undefined;

    const executed: string[] = [];
    if (suggestions?.length) {
      const { roleConfigService } = await import('../roles/role-config.service.js');

      for (const s of suggestions) {
        try {
          if (s.type === 'param_tuning' && s.agentType) {
            // Adjust sessionTimeoutMinutes for the agent type
            const companies = await prisma.company.findMany({ take: 1 });
            if (companies.length > 0) {
              const roleType = s.agentType as any;
              const config = await roleConfigService.get(roleType, companies[0].id);
              if (config) {
                const currentTimeout = config.executionParams?.sessionTimeoutMinutes || 30;
                const newTimeout = Math.max(10, currentTimeout + 10); // Increase timeout by 10min, floor at 10
                await roleConfigService.update(
                  roleType,
                  companies[0].id,
                  { executionParams: { ...config.executionParams, sessionTimeoutMinutes: newTimeout } },
                  'Auditor',
                  `审计建议: ${s.detail}`,
                );
                executed.push(`${s.agentType} sessionTimeout: ${currentTimeout} → ${newTimeout}min`);
                logger.info('[Channel] Auditor suggestion applied: param_tuning', {
                  agentType: s.agentType,
                  oldTimeout: currentTimeout,
                  newTimeout,
                });
              }
            }
          } else if (s.type === 'prompt_optimization') {
            // 仅记录，不自动改 prompt
            executed.push(`${s.agentType}: prompt 优化建议已记录（需手动调整）`);
            logger.info('[Channel] Auditor suggestion noted: prompt_optimization', {
              agentType: s.agentType,
              detail: s.detail,
            });
          }
        } catch (err) {
          logger.warn('[Channel] Failed to apply auditor suggestion', {
            type: s.type,
            error: String(err),
          });
        }
      }
    }

    meta.status = 'confirmed';
    await channelMessageService.createAgentMessage(
      req.params.channelId,
      'Auditor',
      `✅ 审计建议已执行：\n${executed.map(e => `- ${e}`).join('\n')}`,
      { meta: { status: 'done' } },
    );
  } else if (action === 'auditor_apply_reject') {
    // B3-005: 人拒绝审计建议
    meta.status = 'rejected';
    logger.info('[Channel] Auditor suggestions rejected');

    await channelMessageService.createAgentMessage(
      req.params.channelId,
      'Auditor',
      '已拒绝本次审计建议。',
      { meta: { status: 'done' } },
    );
  }

  const updated = await channelMessageService.updateMessageMeta(message.id, meta);

  res.json({ success: true, data: updated });
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

  // Migrate RequirementsDocs to #研发
  await prisma.requirementsDoc.updateMany({
    where: { sourceChannelId: channel.id },
    data: { sourceChannelId: rndChannel.id },
  });

  // Migrate Goals (via context.sourceChannelId) — update context JSON
  const goals = await prisma.goal.findMany({
    where: { context: { contains: channel.id } },
  });
  for (const goal of goals) {
    const ctx = goal.context as Record<string, unknown>;
    if (ctx.sourceChannelId === channel.id) {
      ctx.sourceChannelId = rndChannel.id;
      await prisma.goal.update({
        where: { id: goal.id },
        data: { context: ctx as any },
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
