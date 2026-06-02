// Analyst Trigger Service — B1-001: @Analyst detection → RequirementsDoc
// Upgraded: Claude Code agent (persistent worktree) instead of one-shot API call
//
// P11-04: Split into sub-modules:
//   analyst-knowledge.ts — knowledge loading/saving/filtering
//   analyst-prompt.ts — prompt construction
//   analyst-executor.ts — Claude Code execution + output validation
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { classifyError, formatTriageMessage } from '../triage/error-class.js';
import { channelMessageService } from './channel-message.service.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import { loadKnowledge, saveKnowledge, perInvocationOutputFile } from './analyst-knowledge.js';
import { buildAnalystPrompt } from './analyst-prompt.js';
import { runClaudeCode, validateAnalystOutput, type RequirementsDocJson } from './analyst-executor.js';

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
      const token = process.env.STUDIO_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
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
      // 3. Load accumulated knowledge + build prompt
      const fileKnowledge = loadKnowledge();

      // G-001~005: 加载 DB 知识（偏好 + 规则 + 环境）
      let dbKnowledge = '';
      try {
        const { knowledgeQuery } = await import('../knowledge/knowledge-query.service.js');
        const allKnowledge = await knowledgeQuery.formatAllForPrompt('analyst');
        // B11-005: 知识索引摘要 — 告知 agent 有哪些知识可用及如何 MCP 检索
        const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
        const indexSummary = knowledgeBus.formatIndexSummary();
        dbKnowledge = [allKnowledge, indexSummary ? '\n## 知识检索\n' + indexSummary : ''].filter(Boolean).join('\n');
      } catch (e) {
        logger.warn('[AnalystTrigger] Failed to load DB knowledge, continuing with file only', { error: String(e) });
      }

      // Analyst accuracy 闭环: 加载上次预测准确率 → 定向纠正
      let accuracyReflection = '';
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

      const knowledge = [fileKnowledge, dbKnowledge].filter(Boolean).join('\n');
      const outputFile = perInvocationOutputFile();
      const prompt = await buildAnalystPrompt(content, knowledge, accuracyReflection, outputFile);

      // 4. Run Claude Code agent (ad-hoc session, supports concurrent @Analyst)
      // O1d: Restrict tool access for Simple tasks (short content, no schema change keywords)
      const isSimpleTask = content.length < 500 && !/(schema|migration|migrate|auth|new\s+module|架构重构)/i.test(content);
      const claudeArgs = isSimpleTask ? ['--allowedTools', 'Bash,Edit,Read,Grep'] : undefined;
      const { doc: response, usage } = await runClaudeCode(prompt, outputFile, claudeArgs);
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
      const findings = response.acGroups
        .map(g => `- **${g.id}**: ${g.implementationNotes?.slice(0, 200) || ''}`)
        .join('\n');
      saveKnowledge(response.title || '需求分析', findings);

      // 6. Save RequirementsDoc to DB
      const doc = await prisma.requirementsDoc.create({
        data: {
          title: response.title || '需求分析',
          content: this.formatRequirementsDoc(response),
          acGroups: JSON.stringify(response.acGroups || []),
          contractTests: response.contractTests?.length ? JSON.stringify(response.contractTests) : null,
          tags: JSON.stringify(response.tags || []),
          sourceChannelId: channelId,
          projectId: null,
          status: 'draft',
        },
      });

      // 7. Post card
      const cardMsg = await channelMessageService.createCardMessage(
        channelId,
        'Analyst',
        this.formatCardContent(response),
        'requirements_doc',
        { requirementsDocId: doc.id },
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
        const discoveredFiles = response.acGroups?.flatMap((g: any) => g.files || []) || [];
        const scopeName = response.title ? response.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40) : 'analysis';
        if (discoveredFiles.length > 0) {
          await knowledgeSync.capture({
            scope: scopeName,
            content: [
              `## ${response.title}`,
              response.summary || '',
              '',
              '### Modules Analyzed',
              ...response.acGroups.map((g: any) => `- **${g.id}**: ${g.files?.join(', ') || 'N/A'}`),
              '',
              '### Key Patterns',
              ...(response.acGroups?.flatMap((g: any) => g.codePatterns || []).slice(0, 5) || []).map((p: string) => `- ${p}`),
              '',
              '### Gotchas',
              ...(response.acGroups?.flatMap((g: any) => g.gotchas || []).slice(0, 5) || []).map((g: string) => `- ⚠️ ${g}`),
            ].join('\n'),
            source: 'analyst',
          });
        }

        // P0.2: Write Analyst discoveries to KnowledgeBus (KK→Analyst feedback loop)
        // Subsequent Analyst runs pick these up via knowledgeBus.getRecentContext()
        try {
          const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
          const allGotchas = response.acGroups?.flatMap((g: any) => g.gotchas || []) || [];
          const allPatterns = response.acGroups?.flatMap((g: any) => g.codePatterns || []) || [];
          for (const gotcha of allGotchas.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pitfall',
              title: `[Analyst] ${response.title}: ${gotcha.slice(0, 80)}`,
              content: gotcha,
              severity: 'warning',
              timestamp: Date.now(),
            });
          }
          for (const pattern of allPatterns.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pattern',
              title: `[Analyst] ${response.title}: ${pattern.slice(0, 80)}`,
              content: pattern,
              severity: 'info',
              timestamp: Date.now(),
            });
          }
        } catch { /* KnowledgeBus write-back is best-effort, don't block pipeline */ }

        // G33: Expose discoveries to channel (non-blocking)
        if (response.discoveries?.length) {
          const { discoveryExposure } = await import('./discovery-exposure.service.js');
          discoveryExposure.expose(response.discoveries.map((d: any) => ({
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
      const acCount = response.acGroups?.reduce((sum, g) => sum + g.acs.length, 0) || 0;
      recordPipelineRun({
        source: 'pipeline', phase: 'analyst',
        taskName: response.title || '需求分析',
        model: usage ? 'claude' : 'claude',
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        cacheHitTokens: usage?.cacheHitTokens || 0,
        durationMs,
        success: true,
        sessionId: doc.id,
      }).catch(() => { /* non-blocking */ });

      logger.info('[AnalystTrigger] RequirementsDoc generated', {
        channelId, docId: doc.id, acGroupCount: response.acGroups?.length || 0,
        durationMs, fileKnowledgeSize: fileKnowledge.length, dbKnowledgeSize: dbKnowledge.length,
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
    const acCount = doc.acGroups.reduce((sum, g) => sum + g.acs.length, 0);
    const tags = doc.tags?.length ? `\n🏷️ ${doc.tags.join(' · ')}` : '';
    const guideCount = doc.acGroups.filter(g => g.implementationNotes).length;
    const iv = doc.interfaceVerification;
    const unverifiedWarn = iv?.unverified?.length
      ? `\n⚠️ ${iv.unverified.length} 个接口假设未验证: ${iv.unverified.join(', ')}`
      : '';
    return [
      `## 📋 ${doc.title}`,
      '', doc.summary, '',
      `📊 ${doc.acGroups.length} 模块 · ${acCount} 验收标准 · ${guideCount} 实现指南`,
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
    const sections = [`# ${doc.title}`, '', doc.summary, ''];
    if (doc.interfaceVerification) {
      sections.push(
        '## Schema First Verification',
        '',
        `<!-- INTERFACE_VERIFICATION ${JSON.stringify(doc.interfaceVerification)} -->`,
        '',
        ...(doc.interfaceVerification.verified.length ? ['### Verified', ...doc.interfaceVerification.verified.map(v => `- ✅ ${v}`), ''] : []),
        ...(doc.interfaceVerification.unverified.length ? ['### ⚠️ Unverified', ...doc.interfaceVerification.unverified.map(v => `- ❌ ${v}`), ''] : []),
        ...(doc.interfaceVerification.newRequired.length ? ['### 🆕 New Required', ...doc.interfaceVerification.newRequired.map(v => `- 📝 ${v}`), ''] : []),
      );
    }
    sections.push('', '## AC Groups');
    for (const g of doc.acGroups) {
      sections.push('', `### ${g.id}`);
      if (g.modelTier) {
        sections.push(`<!-- MODEL_TIER ${JSON.stringify({ tier: g.modelTier, reason: g.modelTierReason || '' })} -->`);
      }
      sections.push('', '#### 验收标准');
      for (const ac of g.acs) sections.push(`- [ ] ${ac}`);
      if (g.implementationNotes) {
        sections.push('', '#### 实现指南', g.implementationNotes);
      }
      if (g.codePatterns.length) {
        sections.push('', '#### 参考模式', ...g.codePatterns.map(p => `- ${p}`));
      }
      if (g.gotchas.length) {
        sections.push('', '#### ⚠️ 注意事项', ...g.gotchas.map(gc => `- ${gc}`));
      }
      if (g.files.length) {
        sections.push('', '#### 涉及文件', ...g.files.map(f => `- ${f}`));
      }
      if (g.dependencies.length) {
        sections.push('', `#### 依赖: ${g.dependencies.join(', ')}`);
      }
    }
    if (doc.constraints.length) {
      sections.push('', '## 约束', ...doc.constraints.map(c => `- ${c}`));
    }
    return sections.join('\n');
  }
}

export const analystTriggerService = new AnalystTriggerService();
