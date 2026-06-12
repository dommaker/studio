// Channel Routes — B1-001/B1-002/B1-009/B1-011
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { verifySddFile } from './sdd-verification.js';
import { skillStore } from '../skills/skill-store.js';
import { splitAcGroupsByRepo } from './multi-repo-split.js';
import { goalService } from '../goals/goal.service.js';
import { sharedIngest, scheduleVectorDbSync } from '../knowledge/knowledge-bus.service.js';
import { projectService } from '../pmo/project.service.js';
import { requireAuth } from '../../middleware/auth.js';
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

  // Fetch channel to check mode
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    return res.status(404).json({ success: false, error: 'Channel not found' });
  }

  const message = await channelMessageService.createHumanMessage(
    channelId,
    trimmedContent,
    replyToId || undefined,
  );

  // AS-020 P1-02: Conversation mode routing
  if (channel.mode === 'conversation' && channel.agentName) {
    // Fire-and-forget: route to conversation handler
    import('./conversation-handler.js')
      .then(({ conversationHandler }) =>
        conversationHandler.handle(channel, { id: message.id }, trimmedContent)
      )
      .catch(err =>
        logger.error('[Channel] Conversation handler failed', { error: String(err) })
      );

    logger.info('[Channel] Conversation mode message', { channelId, messageId: message.id, agentName: channel.agentName });
    return res.status(201).json({ success: true, data: { ...message, conversationMode: true } });
  }

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
        const skill = skillStore.findFirst({
          name: { contains: skillName },
          status: 'published',
        });
        if (skill) {
          // Call retract via the skill-proposal-routes logic
          const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
          skillStore.update(skill.id, { status: 'under_review' });
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

  const meta = (typeof message.meta === 'string' ? JSON.parse(message.meta) : message.meta) || {};

  if (action === 'start_execution') {
    const docId = meta.requirementsDocId || meta.cardData?.requirementsDocId;
    const sddSlug = meta.sddSlug || meta.cardData?.sddSlug;
    if (docId) {
      const doc = await prisma.requirementsDoc.findUnique({ where: { id: docId } });
      if (!doc) return res.status(404).json({ success: false, error: 'RequirementsDoc not found' });

      // Idempotency guard: prevent duplicate Goals from race between autoStartExecution + CLI polling
      if (doc.goalId || doc.status === 'confirmed') {
        logger.info('[Channel] start_execution skipped — doc already has goal', { docId, goalId: doc.goalId });
        return res.json({ success: true, data: { skipped: true, goalId: doc.goalId || 'already_confirmed' } });
      }

      // SP-004: Verify SDD file exists (enrichment, non-blocking)
      verifySddFile({ docId, sddSlug });

      // Find or create default company
      let company = await prisma.company.findFirst();
      if (!company) {
        company = await prisma.company.create({ data: { name: 'Default' } });
      }

      // G34: Read acGroups from JSON column (source of truth), fallback to Markdown parse
      let acGroups = doc.acGroups
        ? JSON.parse(doc.acGroups as string)
        : parseAcGroupsFromMarkdown(doc.content);
      // TDD-07: Read contractTests from DB (Analyst 契约测试)
      const contractTests = doc.contractTests
        ? JSON.parse(doc.contractTests as string)
        : undefined;
      const contractTestsSkipReason = (doc as any).contractTestsSkipReason || null;

      // Extract tier from Analyst output (TASK_TIER comment in content)
      const tierMatch = doc.content.match(/<!-- TASK_TIER (.+?) -->/);
      let taskTier: string | undefined;
      if (tierMatch) {
        try {
          const tierData = JSON.parse(tierMatch[1]);
          taskTier = tierData.tier;
        } catch { /* ignore parse error */ }
      }

      // Fast tier: merge all acGroups into 1 (single step, skip integration)
      if (taskTier === 'fast' && acGroups.length > 1) {
        const mergedGroup = {
          id: acGroups.map(g => g.id).join('+'),
          acs: acGroups.flatMap(g => g.acs),
          files: [...new Set(acGroups.flatMap(g => g.files || []))],
          dependencies: [],
          implementationNotes: acGroups.map(g => `### ${g.id}\n${g.implementationNotes || ''}`).join('\n\n'),
          codePatterns: acGroups.flatMap(g => g.codePatterns || []),
          gotchas: acGroups.flatMap(g => g.gotchas || []),
          modelTier: 'fast' as const,
          modelTierReason: 'fast tier: merged all acGroups into single step',
        };
        logger.info('[Channel] Fast tier: merged acGroups', {
          from: acGroups.length,
          to: 1,
          totalAcs: mergedGroup.acs.length,
          totalFiles: mergedGroup.files.length,
        });
        acGroups = [mergedGroup];
      }

      // Phase 3: 无契约测试且无 skipReason → 阻断
      if (!contractTests?.length && !contractTestsSkipReason) {
        logger.warn('[Channel] RequirementsDoc missing contractTests and skipReason — blocking execution', { docId });
        // 更新 card status 为 blocked，阻止 CLI 无限重试
        await channelMessageService.updateMessage(req.params.messageId, {
          meta: { ...meta, status: 'blocked' },
        }).catch(() => {});
        try {
          await channelMessageService.createAgentMessage(req.params.channelId, 'System',
            `## ⚠️ 缺少契约测试\n\nRequirementsDoc 没有包含契约测试（contractTests）且未说明跳过原因。管线要求 Analyst 输出可执行的契约测试，或填写 contractTestsSkipReason 说明为何不需要。\n\n请重新触发 @Analyst 分析需求。`
          );
        } catch { /* best-effort */ }
        return res.status(400).json({ success: false, error: 'Missing contractTests and skipReason in RequirementsDoc' });
      }

      const groupIdToIndex = new Map(acGroups.map((g, i) => [g.id, i]));

      // O1c: Extract Analyst context for each AC group (prevents Executor from re-exploring verified files)
      const ivMatchO1c = doc.content.match(/<!-- INTERFACE_VERIFICATION (.+?) -->/);
      const interfaceVerificationStr = ivMatchO1c ? ivMatchO1c[1] : null;
      for (const group of acGroups) {
        (group as any)._analystContext = {
          verifiedFiles: group.files || [],
          interfaceVerification: interfaceVerificationStr,
          gotchas: group.gotchas || [],
          architectureContext: (group as any).architectureContext || '',
        };
      }

      // Assess risk (B1-009): check for sensitive keywords in ACs
      const allAcs = acGroups.flatMap(g => g.acs).join(' ');
      const risks: string[] = [];
      if (/auth|login|password|token|oauth|jwt|session|credential/i.test(allAcs)) risks.push('auth');
      if (/database|schema|migration|prisma|sql|table|index/i.test(allAcs)) risks.push('schema_change');
      if (/api|endpoint|route|middleware|webhook/i.test(allAcs)) risks.push('api_change');
      if (/payment|billing|transaction|balance|money/i.test(allAcs)) risks.push('financial');

      // RequirementGate: 验证 AC 组质量（粒度/文件/依赖/独立性）
      // Resolve monorepo root (Analyst writes paths relative to monorepo root, not api package dir)
      const repoDir = process.env.REPO_DIR || (() => {
        let dir = process.cwd();
        while (dir !== '/' && !fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
          dir = path.dirname(dir);
        }
        return dir;
      })();
      try {
        const { validateRequirementsDoc } = await import('../agents/requirement-gate.js');
        // Extract Schema First verification from doc content
        const ivMatch = doc.content.match(/<!-- INTERFACE_VERIFICATION (.+?) -->/);
        const interfaceVerification = ivMatch ? JSON.parse(ivMatch[1]) : undefined;
        const gateResult = await validateRequirementsDoc(acGroups, doc.title, repoDir, interfaceVerification);

        if (!gateResult.passed) {
          // Push feedback to Channel
          logger.warn('[Channel] RequirementGate: AC group quality check failed', {
            docId,
            issues: gateResult.suggestions,
            tier: gateResult.tierRecommendation,
          });
          try {
            await channelMessageService.createAgentMessage(
              req.params.channelId,
              'System',
              `## ⚠️ RequirementGate 检查未通过\n\nRequirementsDoc 格式验证已通过，但 AC 结构需要修正：\n\n${
                gateResult.suggestions.map(s => `- ${s}`).join('\n')
              }\n\n**建议**: ${
                gateResult.tierRecommendation === 'needs-human'
                  ? '请 @Analyst 修正上述问题后重新 /plan'
                  : '已自动升级为 premium 模型重新分析'
              }`,
              { meta: { cardType: 'gate_rejected' } }
            );
          } catch { /* best-effort */ }

          if (gateResult.tierRecommendation === 'needs-human') {
            return res.status(400).json({ success: false, error: 'RequirementsDoc quality check failed', gateResult });
          }

          // upgrade-to-premium: trigger Analyst revision with gate feedback
          if (gateResult.tierRecommendation === 'upgrade-to-premium') {
            const revMatch = doc.content.match(/<!-- GATE_REVISION_ATTEMPT (\d+) -->/);
            const revisionAttempt = revMatch ? parseInt(revMatch[1], 10) : 0;

            if (revisionAttempt >= 2) {
              // Max revision attempts reached — block
              logger.warn('[Channel] RequirementGate: max revision attempts reached', { docId, revisionAttempt });
              try {
                await channelMessageService.createAgentMessage(
                  req.params.channelId, 'System',
                  `## ⚠️ 自动修正已达上限\n\nRequirementsDoc 经过 ${revisionAttempt} 次自动修正仍未通过质量检查。请 @Analyst 手动修正后重新 /plan。`,
                  { meta: { cardType: 'gate_rejected' } }
                );
              } catch { /* best-effort */ }
              return res.status(400).json({ success: false, error: 'Max gate revision attempts reached', gateResult });
            }

            // Trigger Analyst revision (fire-and-forget)
            logger.info('[Channel] RequirementGate: triggering Analyst revision', { docId, revisionAttempt });
            const { buildRevisionPrompt: buildRevPrompt } = await import('./analyst-prompt.js');
            const revisionPrompt = buildRevPrompt(
              doc.title,
              gateResult.suggestions,
              doc.content,
              revisionAttempt,
            );

            // Update doc content with revision marker for next gate check
            await prisma.requirementsDoc.update({
              where: { id: docId },
              data: { content: doc.content.replace(/<!-- GATE_REVISION_ATTEMPT \d+ -->\n?/, '') + `\n<!-- GATE_REVISION_ATTEMPT ${revisionAttempt + 1} -->` },
            }).catch((e: unknown) => logger.error('[Channel] Failed to update doc revision marker', { error: String(e) }));

            import('./analyst-trigger.service.js')
              .then(({ analystTriggerService }) =>
                analystTriggerService.trigger(req.params.channelId, null, revisionPrompt)
              )
              .catch((err: unknown) =>
                logger.error('[Channel] Analyst revision trigger failed', { error: String(err) })
              );
            return; // Analyst revision will re-trigger start_execution via autoStartExecution
          }
        } else {
          logger.info('[Channel] RequirementGate: passed', { docId, groups: acGroups.length });
        }
      } catch (e: any) {
        logger.error('[Channel] RequirementGate failed — blocking', { error: String(e) });
        try {
          await channelMessageService.createAgentMessage(req.params.channelId, 'System',
            `## ⚠️ 需求验证异常\n\nRequirementGate 执行失败: ${String(e).slice(0, 200)}\n\n请 @channel 排查后重新触发。`
          );
        } catch { /* best-effort */ }
        return res.status(500).json({ success: false, error: 'RequirementGate failed' });
      }

      // D6: Fact verification — check architectureContext claims against codebase
      try {
        const { verifyAnalystFacts } = await import('./analyst-fact-verification.js');
        const factResults = verifyAnalystFacts(acGroups, repoDir);
        const factFailures = factResults.filter(r => !r.passed);
        if (factFailures.length > 0) {
          logger.warn('[Channel] D6 fact verification: issues found', {
            docId,
            issues: factFailures.map(r => r.message),
          });
          // Soft warning — don't block, but record for downstream awareness
          for (const group of acGroups) {
            (group as any)._factWarnings = factFailures.map(r => r.message);
          }
        } else {
          logger.info('[Channel] D6 fact verification: passed', { docId });
        }
      } catch (e: any) {
        logger.warn('[Channel] D6 fact verification failed (non-blocking)', { error: String(e) });
      }

      // A6: Check for duplicate PMO project
      const existingProject = await prisma.project.findFirst({
        where: {
          companyId: company.id,
          title: { contains: doc.title.slice(0, 30) },
          status: { in: ['pending', 'active', 'in_review'] },
        },
      });
      if (existingProject) {
        logger.info('[Channel] Duplicate PMO detected', { existingId: existingProject.id, pmoNumber: existingProject.pmoNumber });
      }

      // A1: Create PMO project before Goal
      let projectId = doc.projectId;
      if (!projectId) {
        const okr = await prisma.oKR.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'desc' } });
        const pmoProject = await projectService.create({
          companyId: company.id,
          title: doc.title,
          requirement: doc.content.slice(0, 500),
          okrId: okr?.id || undefined,
          priority: risks.length > 0 ? 'high' : 'medium',
          requirementsDocId: docId,
        });
        projectId = pmoProject.id;
        // Update RequirementsDoc with projectId
        await prisma.requirementsDoc.update({ where: { id: docId }, data: { projectId } });
        logger.info('[Channel] PMO project created', { pmoNumber: pmoProject.pmoNumber, projectId });
      }

      // Dedup: same title + same company → skip if already succeeded/running, allow retry if failed
      const normalizedTitle = doc.title.trim().toLowerCase();
      const existingGoals = await prisma.goal.findMany({
        where: { companyId: company.id },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const duplicate = existingGoals.find(g => g.title.trim().toLowerCase() === normalizedTitle && ['succeeded', 'running', 'executing', 'pending', 'draft'].includes(g.status));
      if (duplicate) {
        const msg = duplicate.status === 'succeeded'
          ? `⏭️ 跳过：相同需求已成功完成 (Goal \`${duplicate.id.slice(0, 8)}\`)`
          : `⏭️ 跳过：相同需求正在执行中 (Goal \`${duplicate.id.slice(0, 8)}\`, status: ${duplicate.status})`;
        await channelMessageService.createAgentMessage(req.params.channelId, 'Executor', msg, { meta: { goalId: duplicate.id, status: 'skipped_duplicate' } });
        logger.info('[Channel] Duplicate Goal skipped', { existingGoalId: duplicate.id, status: duplicate.status, title: doc.title.slice(0, 80) });
        meta.status = 'skipped';
        meta.goalId = duplicate.id;
        return; // early exit — no separate return needed inside if block
      }

      // AS-023: Resolve targetRepo from acGroups → WorkspaceRepo
      let workspaceRepoId: string | undefined;
      const targetRepos = [...new Set(acGroups.map((g: any) => g.targetRepo).filter(Boolean))];
      if (targetRepos.length === 1) {
        // All acGroups target the same repo — bind to project
        try {
          const repo = await prisma.workspaceRepo.findFirst({
            where: { name: targetRepos[0], status: 'active' },
            select: { id: true, workspaceId: true },
          });
          if (repo) {
            workspaceRepoId = repo.id;
            // Update project with workspaceRepoId
            if (projectId) {
              await prisma.project.update({
                where: { id: projectId },
                data: { workspaceRepoId },
              });
            }
            logger.info('[Channel] WorkspaceRepo bound', { repoName: targetRepos[0], workspaceRepoId });
          }
        } catch { /* fallback: no workspaceRepoId */ }
      } else if (targetRepos.length > 1) {
        logger.info('[Channel] Multiple targetRepos detected — splitting into separate Goals', { targetRepos });
      }

      // P3: Split acGroups by targetRepo → create separate Goals per repo
      const repoGroups = targetRepos.length > 1
        ? splitAcGroupsByRepo(acGroups as any)
        : [{ targetRepo: targetRepos[0] || '__default__', acGroups: acGroups as any }];

      const results: Array<{ goalId: string; stepCount: number }> = [];

      for (const group of repoGroups) {
        // Resolve workspaceRepoId for this group
        let groupRepoId: string | undefined;
        if (group.targetRepo !== '__default__') {
          try {
            const repo = await prisma.workspaceRepo.findFirst({
              where: { name: group.targetRepo, status: 'active' },
              select: { id: true },
            });
            if (repo) groupRepoId = repo.id;
          } catch { /* fallback */ }
        }
        // Fall back to the single-repo workspaceRepoId resolved earlier
        groupRepoId = groupRepoId || workspaceRepoId;

        const result = await goalService.createGoalFromChannelDoc({
          title: repoGroups.length > 1 ? `${doc.title} [${group.targetRepo}]` : doc.title,
          summary: doc.content.slice(0, 200),
          acGroups: group.acGroups,
          companyId: company.id,
          sourceChannelId: req.params.channelId,
          requirementsDocId: docId,
          sddSlug: sddSlug || undefined,
          projectId,
          risks,
          ...(groupRepoId ? { workspaceRepoId: groupRepoId } : {}),
          ...(contractTests?.length ? { contractTests } : {}),
        });
        results.push(result);
      }

      const primaryResult = results[0];

      // Update RequirementsDoc with primary Goal ID
      await prisma.requirementsDoc.update({
        where: { id: docId },
        data: { status: 'confirmed', goalId: primaryResult.goalId },
      });

      meta.status = 'executing';
      meta.goalId = primaryResult.goalId;

      // Post progress message
      const riskNote = risks.length > 0
        ? `\n⚠️ 风险标注: ${risks.join(', ')}`
        : '';
      if (results.length === 1) {
        await channelMessageService.createAgentMessage(
          req.params.channelId,
          'Executor',
          `✅ 已创建 Goal \`${primaryResult.goalId.slice(0, 8)}\`，${primaryResult.stepCount} 个执行组排队中。${riskNote}`,
          { meta: { goalId: primaryResult.goalId, status: 'queued', risks } },
        );
      } else {
        const goalLines = results.map(r =>
          `- \`${r.goalId.slice(0, 8)}\` (${r.stepCount} 步)`
        ).join('\n');
        await channelMessageService.createAgentMessage(
          req.params.channelId,
          'Executor',
          `✅ 跨仓需求拆分为 ${results.length} 个 Goal：\n${goalLines}${riskNote}`,
          { meta: { goalIds: results.map(r => r.goalId), status: 'queued', risks } },
        );
      }

      logger.info('[Channel] Goal(s) created from RequirementsDoc', {
        docId, goalCount: results.length, goalIds: results.map(r => r.goalId), risks,
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
      for (const entry of entries) {
        // harness 文件存储
        sharedIngest.ingestEntry(
          { type: entry.type as any, title: entry.title, content: entry.content, tags: entry.tags, projects: [projectId || taskId] },
          { source: source || `task:${taskId}`, layer: 'project', maturity: 'draft', tags: entry.tags, projects: [projectId || taskId] },
        );
        scheduleVectorDbSync();

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
      skillStore.update(skillId, { status: 'deprecated' });

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

// POST /api/v1/channels/:id/convert — convert conversation to pipeline (AS-020 P10)
router.post('/:id/convert', requireAuth(), async (req, res) => {
  const channelId = req.params.id;

  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    return res.status(404).json({ success: false, error: 'Channel not found' });
  }

  try {
    const { convertConversationToPipeline } = await import('./conversation-converter.js');
    const result = await convertConversationToPipeline(channelId);
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'No conversation messages found in channel') {
      return res.status(400).json({ success: false, error: message });
    }
    logger.error('[Channel] Conversation conversion failed', { channelId, error: message });
    res.status(500).json({ success: false, error: 'Conversion failed' });
  }
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
    const ctx = (typeof goal.context === 'string' ? JSON.parse(goal.context) : goal.context) as Record<string, unknown>;
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
