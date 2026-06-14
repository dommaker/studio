// Analyst Trigger Service — B1-001: @Analyst detection → RequirementsDoc
// Upgraded: Claude Code agent (persistent worktree) instead of one-shot API call
//
// P11-04: Split into sub-modules:
//   analyst-knowledge.ts — knowledge loading/saving/filtering
//   analyst-prompt.ts — prompt construction
//   analyst-executor.ts — Claude Code execution + output validation
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus, toKebab, writeSddDoc, appendChangelog } from '@dommaker/studio-shared';
import { classifyError, formatTriageMessage } from '../triage/error-class.js';
import { channelMessageService } from './channel-message.service.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import { saveKnowledge, perInvocationOutputFile } from './analyst-knowledge.js';
import { buildAnalystPrompt } from './analyst-prompt.js';
import { runClaudeCode, validateAnalystOutput, preClassifyTier, type RequirementsDocJson } from './analyst-executor.js';

export type { RequirementsDocJson } from './analyst-executor.js';

// ── Service ──

class AnalystTriggerService {
  async trigger(channelId: string, triggerMessageId: string | null, content: string): Promise<void> {
    // 1. Dedup: use daemon session state, not ChannelMessage (失败消息不应阻断重试)
    const { daemon } = await import('../../daemon/studio-daemon.js');
    const status = daemon.getStatus('analyst') as { isBusy: boolean; lastUsed: number } | null;
    const COOLDOWN_MS = 5 * 60 * 1000;
    if (status) {
      if (status.isBusy) {
        logger.info('[AnalystTrigger] Skipped — analyst session is busy', { channelId });
        return;
      }
      if (status.lastUsed > 0 && (Date.now() - status.lastUsed) < COOLDOWN_MS) {
        logger.info('[AnalystTrigger] Skipped — analysis completed recently', {
          channelId,
          secondsAgo: Math.round((Date.now() - status.lastUsed) / 1000),
        });
        return;
      }
    }

    // 1b. Pre-flight: verify API key + Claude availability before spending tokens
    try {
      const token = process.env.STUDIO_API_KEY;
      if (!token || token.length < 10) {
        logger.error('[AnalystTrigger] Pre-flight failed — STUDIO_API_KEY missing or invalid');
        return;
      }
    } catch { /* best-effort */ }

    // 2. Post "thinking" message
    const thinkingMsg = await channelMessageService.createAgentMessage(
      channelId,
      'Analyst',
      '🔍 正在探索代码库并分析需求... (0s)',
      { meta: { status: 'thinking' } },
    );

    // Progress heartbeat — update thinking message every 30s
    const startTime = Date.now();
    const progressInterval = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      try {
        await channelMessageService.updateMessage(thinkingMsg.id, {
          content: `🔍 正在探索代码库并分析需求... (${elapsed}s)`,
        });
      } catch (e) {
        logger.error('[AnalystTrigger] Failed to update progress message', { error: String(e) });
      }
    }, 30000);

    try {
      // 3. Build prompt (fileKnowledge removed — Analyst explores fresh each time)
      const preAnalystStart = Date.now();
      const preTier = preClassifyTier(content);

      // FIX #2: fast-tier 跳过 DB knowledge + accuracy reflection（节省 ~30% token）
      let dbKnowledge = '';
      let accuracyReflection = '';

      if (preTier !== 'fast') {
        // G-001~005: 加载 DB 知识（unified via buildKnowledgeContext）
        try {
          const { buildKnowledgeContext } = await import('../knowledge/consumers/prompt-builder.js');
          dbKnowledge = await buildKnowledgeContext('analyst', { mode: 'full' });
        } catch (e) {
          logger.warn('[AnalystTrigger] Failed to load DB knowledge, continuing with file only', { error: String(e) });
        }

        // Analyst accuracy 闭环: 加载上次预测准确率 → 定向纠正
        try {
          const { sharedStore } = await import('../knowledge/knowledge-bus.service.js');
          const accuracyEntries = sharedStore.list({ tags: ['analyst_accuracy'] })
            .filter(e => e.maturity !== 'archived')
            .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
            .slice(0, 3);
          if (accuracyEntries.length > 0) {
            const lines = [
              '## 预测反思（自动分析）',
              '以下是你在之前分析中的预测准确率记录，请针对性改进：',
            ];
            for (const e of accuracyEntries) {
              const eContent = e.content || '';
              const fileMatch = eContent.match(/AC匹配率:\s*(\d+)%/);
              const missed = eContent.match(/漏预测文件:\s*([^\]]+)/);
              const extra = eContent.match(/多预测文件:\s*([^\]]+)/);
              const missedDeps = eContent.match(/漏预测依赖:\s*([^\]]+)/);
              const suggestions: string[] = [];
              if (missed) suggestions.push(`文件遗漏: ${missed[1].trim()}`);
              if (extra) suggestions.push(`文件多报: ${extra[1].trim()}`);
              if (missedDeps) suggestions.push(`依赖遗漏: ${missedDeps[1].trim()}`);
              if (!missed && !extra && !missedDeps && fileMatch) {
                suggestions.push('预测准确，继续保持');
              }
              const matchRate = fileMatch ? `${fileMatch[1]}%` : 'N/A';
              lines.push(`- ⚠️ [准确率:${matchRate}] ${e.title}: ${suggestions.join('; ') || eContent.slice(0, 200)}`);
            }
            lines.push(
              '',
              '**改进提示**: 以上述模式为鉴，重点检查是否漏报了文件、是否漏声明了依赖关系。',
            );
            accuracyReflection = lines.join('\n') + '\n';
          }
        } catch (e) {
          logger.warn('[AnalystTrigger] Failed to load analyst accuracy', { error: String(e) });
        }
      } else {
        logger.info('[AnalystTrigger] Fast-tier: skipping DB knowledge + accuracy reflection');
      }

      const knowledge = dbKnowledge;
      const outputFile = perInvocationOutputFile();
      logger.info('[AnalystTrigger] Pre-classified tier', { tier: preTier, contentLength: content.length });

      // AS-023: Query available repos for Analyst prompt injection
      let availableRepos: Array<{ name: string; path: string; category?: string; description?: string }> | undefined;
      try {
        const repos = await prisma.workspaceRepo.findMany({
          where: { status: 'active' },
          select: { name: true, path: true, category: true, description: true },
          orderBy: { name: 'asc' },
        });
        if (repos.length > 0) availableRepos = repos;
      } catch { /* fallback: no repo list injected */ }

      const prompt = await buildAnalystPrompt(content, knowledge, accuracyReflection, outputFile, preTier, availableRepos);
      const preAnalystDurationMs = Date.now() - preAnalystStart;

      // 4. Run Claude Code agent (ad-hoc session, supports concurrent @Analyst)
      // O1d: Restrict tool access for Simple tasks (short content, no schema change keywords)
      const isSimpleTask = content.length < 500 && !/(schema|migration|migrate|auth|new\s+module|架构重构)/i.test(content);
      const claudeArgs = isSimpleTask ? ['--allowedTools', 'Bash,Edit,Read,Grep'] : undefined;
      const { doc: response, usage } = await runClaudeCode(prompt, outputFile, claudeArgs, preTier);
      const durationMs = Date.now() - startTime;
      clearInterval(progressInterval);

      // B5-H01: 验证 Analyst 输出结构
      const validationErrors = validateAnalystOutput(response);
      if (validationErrors.length > 0) {
        logger.error('[AnalystTrigger] Output validation failed', { errors: validationErrors, channelId });
        await channelMessageService.createAgentMessage(channelId, 'System',
          `## ⚠️ Analyst 输出格式错误\n\n${validationErrors.join('\n')}\n\n请重新 @Analyst 触发分析。`
        );
        return;
      }

      // 5. Save new knowledge for next analysis
      const findings = response.design.acGroups
        .map(g => `- **${g.id}**: ${g.implementationNotes?.slice(0, 200) || ''}`)
        .join('\n');
      saveKnowledge(response.requirement.title || '需求分析', findings);

      // 6. Save RequirementsDoc to DB
      const allContractTests = response.task.acGroups.flatMap(g => g.contractTests || []);
      const allContractTestsSkipReasons = response.task.acGroups
        .map(g => g.contractTestsSkipReason)
        .filter(Boolean);
      const doc = await prisma.requirementsDoc.create({
        data: {
          title: response.requirement.title || '需求分析',
          content: this.formatRequirementsDoc(response),
          acGroups: JSON.stringify(response.requirement.acGroups || []),
          contractTests: allContractTests.length ? JSON.stringify(allContractTests) : null,
          contractTestsSkipReason: allContractTestsSkipReasons[0] || null,
          tags: JSON.stringify(response.requirement.tags || []),
          sourceChannelId: channelId,
          projectId: null,
          status: 'draft',
        },
      });

      // 6b. Write SDD files to disk (SP-004)
      const slug = toKebab(response.requirement.title || 'analysis');
      try {
        const now = new Date().toISOString();
        const version = 1;

        // Requirement layer: What
        // Collect unique file paths from all AC groups, stripping line ranges
        const allFiles = [...new Set(
          response.requirement.acGroups
            .flatMap((g) => g.files || [])
            .filter(Boolean)
            .map((f) => f.replace(/:L?\d+(-L?\d+)?$/, '')),
        )];

        writeSddDoc(slug, 'requirement', {
          id: doc.id,
          goalId: doc.goalId || undefined,
          slug,
          title: response.requirement.title || '需求分析',
          status: 'draft',
          tier: (response.requirement.tier as any) || 'standard',
          version,
          requirementVersion: version,
          designVersion: version,
          taskVersion: version,
          sourceChannelId: channelId,
          tags: response.requirement.tags || [],
          createdAt: now,
          updatedAt: now,
        }, [
          `## ${response.requirement.title}`,
          '',
          response.requirement.summary || '',
          '',
          '## AC Groups',
          '',
          ...response.requirement.acGroups.map((g) => [
            `### ${g.id}`,
            '',
            ...g.acs.map((ac: string) => `- ${ac}`),
            '',
            `**Files**: ${g.files?.join(', ') || 'N/A'}`,
            `**Dependencies**: ${g.dependencies?.join(', ') || 'N/A'}`,
            g.targetRepo ? `**Target Repo**: ${g.targetRepo}` : '',
          ].join('\n')),
          '',
          '## Files',
          '',
          ...allFiles.map((f) => `- ${f}`),
        ].join('\n'));

        // Design layer: How
        writeSddDoc(slug, 'design', {
          id: doc.id, slug, title: response.requirement.title || '',
          status: 'draft', tier: (response.requirement.tier as any) || 'standard',
          version, requirementVersion: version, designVersion: version, taskVersion: version,
          createdAt: now, updatedAt: now,
        }, [
          '## Design',
          '',
          ...response.design.acGroups.map((g) => [
            `### ${g.id}`,
            '',
            '**Implementation Notes**',
            g.implementationNotes || 'N/A',
            '',
            ...(g.architectureContext ? [
              '**Architecture Context**',
              `- Functions: ${g.architectureContext.functions?.join(', ') || 'N/A'}`,
              `- Call Chain: ${g.architectureContext.callChain || 'N/A'}`,
              `- Imports: ${g.architectureContext.imports?.join(', ') || 'N/A'}`,
              `- Danger Zones: ${g.architectureContext.dangerZones?.join(', ') || 'N/A'}`,
              `- Verified At: ${g.architectureContext.verifiedAt || 'N/A'}`,
              '',
            ] : []),
            ...(g.codePatterns?.length ? ['**Code Patterns**', ...g.codePatterns.map((p: string) => `- ${p}`), ''] : []),
            ...(g.gotchas?.length ? ['**Gotchas**', ...g.gotchas.map((h: string) => `- ${h}`), ''] : []),
          ].join('\n')),
        ].join('\n'));

        // Task layer: Verify
        const allTaskContractTests = response.task.acGroups.flatMap(g => g.contractTests || []);
        const taskSkipReason = response.task.acGroups.map(g => g.contractTestsSkipReason).filter(Boolean)[0];
        writeSddDoc(slug, 'task', {
          id: doc.id, slug, title: response.requirement.title || '',
          status: 'draft', tier: (response.requirement.tier as any) || 'standard',
          version, requirementVersion: version, designVersion: version, taskVersion: version,
          createdAt: now, updatedAt: now,
        }, [
          '## Contract Tests',
          '',
          ...(allTaskContractTests.length
            ? allTaskContractTests.map((t) => [
                `### ${t.file}`,
                '```typescript',
                t.content,
                '```',
              ].join('\n'))
            : [taskSkipReason || 'No contract tests']),
        ].join('\n'));

        appendChangelog(slug, `Created from Analyst output (channel: ${channelId}, doc: ${doc.id})`);
        logger.info('[AnalystTrigger] SDD files written', { slug, docId: doc.id });
      } catch (sddErr) {
        logger.warn('[AnalystTrigger] SDD file write failed (non-blocking)', { error: String(sddErr) });
      }

      // 7. Post card
      const cardMsg = await channelMessageService.createCardMessage(
        channelId,
        'Analyst',
        this.formatCardContent(response),
        'requirements_doc',
        { requirementsDocId: doc.id, sddSlug: slug },
        triggerMessageId ?? undefined,
      );

      await channelMessageService.deleteMessage(thinkingMsg.id);
      eventBus.publish('channel.requirements_ready', { channelId, requirementsDocId: doc.id });

      // Q8: 自动触发 start_execution — Analyst 完成即开始执行，无需人工点击
      this.autoStartExecution(channelId, cardMsg.id).catch((e: any) => {
        logger.warn('[AnalystTrigger] Auto-start failed (card will show start button)', { error: String(e) });
      });

      // 8. Auto-capture architectural knowledge (KnowledgeSync Cycle 1)
      try {
        const { knowledgeSync } = await import('../knowledge/knowledge-sync.service.js');
        const discoveredFiles = response.requirement.acGroups?.flatMap((g) => g.files || []) || [];
        const scopeName = response.requirement.title ? response.requirement.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40) : 'analysis';
        if (discoveredFiles.length > 0) {
          await knowledgeSync.capture({
            scope: scopeName,
            content: [
              `## ${response.requirement.title}`,
              response.requirement.summary || '',
              '',
              '### Modules Analyzed',
              ...response.requirement.acGroups.map((g) => `- **${g.id}**: ${g.files?.join(', ') || 'N/A'}`),
              '',
              '### Key Patterns',
              ...(response.design.acGroups?.flatMap((g) => g.codePatterns || []).slice(0, 5) || []).map((p: string) => `- ${p}`),
              '',
              '### Gotchas',
              ...(response.design.acGroups?.flatMap((g) => g.gotchas || []).slice(0, 5) || []).map((g: string) => `- ⚠️ ${g}`),
            ].join('\n'),
            source: 'analyst',
          });
        }

        // P0.2: Write Analyst discoveries to KnowledgeBus (KK→Analyst feedback loop)
        // Subsequent Analyst runs pick these up via knowledgeBus.getRecentContext()
        try {
          const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
          const allGotchas = response.design.acGroups?.flatMap((g) => g.gotchas || []) || [];
          const allPatterns = response.design.acGroups?.flatMap((g) => g.codePatterns || []) || [];
          for (const gotcha of allGotchas.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pitfall',
              title: `[Analyst] ${response.requirement.title}: ${gotcha.slice(0, 80)}`,
              content: gotcha,
              severity: 'warning',
              timestamp: Date.now(),
            });
          }
          for (const pattern of allPatterns.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pattern',
              title: `[Analyst] ${response.requirement.title}: ${pattern.slice(0, 80)}`,
              content: pattern,
              severity: 'info',
              timestamp: Date.now(),
            });
          }
        } catch { /* KnowledgeBus write-back is best-effort, don't block pipeline */ }

        // G33: Expose discoveries to channel (non-blocking)
        if (response.requirement.discoveries?.length) {
          const { discoveryExposure } = await import('./discovery-exposure.service.js');
          discoveryExposure.expose(response.requirement.discoveries.map((d) => ({
            source: 'analyst' as const,
            type: d.type || 'observation',
            severity: d.severity || 'medium',
            file: d.file || '',
            title: d.title || '',
            description: d.description || '',
            effort: d.effort,
          })), channelId).catch((e: any) => logger.warn('[AnalystTrigger] Discovery exposure failed', { error: String(e) }));
        }
      } catch (e: any) {
        logger.warn('[AnalystTrigger] KnowledgeSync capture failed (non-blocking)', { error: String(e) });
      }

      // 9. Record Analyst phase metrics
      // 9a. Pre-analyst knowledge search (0 tokens, duration only)
      recordPipelineRun({
        source: 'pipeline', phase: 'analyst',
        taskName: `pre-analyst:${response.requirement.title || '需求分析'}`,
        model: 'knowledge-search',
        inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
        durationMs: preAnalystDurationMs,
        success: true,
        sessionId: doc.id,
      }).catch((e: any) => {
        logger.error('[AnalystTrigger] Pre-analyst metrics FAILED', { error: String(e) });
      });

      // 9b. Analyst Claude session
      recordPipelineRun({
        source: 'pipeline', phase: 'analyst',
        taskName: response.requirement.title || '需求分析',
        model: `claude-${preTier}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        durationMs: durationMs - preAnalystDurationMs,
        success: true,
        sessionId: doc.id,
      }).catch((e: any) => {
        logger.error('[AnalystTrigger] PipelineRun record FAILED', { error: String(e), docId: doc.id });
      });

      logger.info('[AnalystTrigger] RequirementsDoc generated', {
        channelId, docId: doc.id, acGroupCount: response.requirement.acGroups?.length || 0,
        durationMs, dbKnowledgeSize: dbKnowledge.length,
        tokens: usage,
      });
    } catch (err) {
      clearInterval(progressInterval);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const triage = classifyError(errorMessage);
      logger.error('[AnalystTrigger] Analysis failed', { error: errorMessage, triage });

      await channelMessageService.updateMessage(thinkingMsg.id, {
        content: `❌ 分析失败\n\n${formatTriageMessage(triage)}`,
        meta: { status: 'error', error: errorMessage, triage } as any,
      });
    }
  }

  // ── Formatting ──

  private formatCardContent(doc: RequirementsDocJson): string {
    const acCount = doc.requirement.acGroups.reduce((sum, g) => sum + g.acs.length, 0);
    const tags = doc.requirement.tags?.length ? `\n🏷️ ${doc.requirement.tags.join(' · ')}` : '';
    const guideCount = doc.design.acGroups.filter(g => g.implementationNotes).length;
    const iv = doc.requirement.interfaceVerification;
    const unverifiedWarn = iv?.unverified?.length
      ? `\n⚠️ ${iv.unverified.length} 个接口假设未验证: ${iv.unverified.join(', ')}`
      : '';
    return [
      `## 📋 ${doc.requirement.title}`,
      '', doc.requirement.summary, '',
      `📊 ${doc.requirement.acGroups.length} 模块 · ${acCount} 验收标准 · ${guideCount} 实现指南`,
      `✅ 结构验证通过`,
      tags,
      unverifiedWarn,
    ].join('\n');
  }

  /**
   * Q8: 自动触发 start_execution — 通过内部 HTTP 调用 actions 端点
   */
  private async autoStartExecution(channelId: string, cardMessageId: string): Promise<void> {
    const port = process.env.PORT || '3001';
    const resp = await fetch(`http://127.0.0.1:${port}/api/v1/channels/${channelId}/messages/${cardMessageId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_execution' }),
    });
    const result = await resp.json() as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'start_execution failed');
    }
  }

  private formatRequirementsDoc(doc: RequirementsDocJson): string {
    const req = doc.requirement;
    const sections = [`# ${req.title}`, '', req.summary, ''];
    if (req.tier) {
      sections.push(`<!-- TASK_TIER ${JSON.stringify({ tier: req.tier, reason: req.tierReason || '' })} -->`, '');
    }
    if (req.interfaceVerification) {
      sections.push(
        '## Schema First Verification',
        '',
        `<!-- INTERFACE_VERIFICATION ${JSON.stringify(req.interfaceVerification)} -->`,
        '',
        ...(req.interfaceVerification.verified.length ? ['### Verified', ...req.interfaceVerification.verified.map(v => `- ✅ ${v}`), ''] : []),
        ...(req.interfaceVerification.unverified.length ? ['### ⚠️ Unverified', ...req.interfaceVerification.unverified.map(v => `- ❌ ${v}`), ''] : []),
        ...(req.interfaceVerification.newRequired.length ? ['### 🆕 New Required', ...req.interfaceVerification.newRequired.map(v => `- 📝 ${v}`), ''] : []),
      );
    }
    sections.push('', '## AC Groups');
    for (const g of req.acGroups) {
      sections.push('', `### ${g.id}`);
      sections.push('', '#### 验收标准');
      for (const ac of g.acs) sections.push(`- [ ] ${ac}`);
      if (g.files.length) {
        sections.push('', '#### 涉及文件', ...g.files.map(f => `- ${f}`));
      }
      if (g.dependencies.length) {
        sections.push('', `#### 依赖: ${g.dependencies.join(', ')}`);
      }
    }
    if (req.constraints.length) {
      sections.push('', '## 约束', ...req.constraints.map(c => `- ${c}`));
    }
    return sections.join('\n');
  }
}

export const analystTriggerService = new AnalystTriggerService();
