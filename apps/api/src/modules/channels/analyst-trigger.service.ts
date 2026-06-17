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
import { perInvocationOutputFile } from './analyst-knowledge.js';
import { buildAnalystPrompt } from './analyst-prompt.js';
import { runClaudeCode, validateAnalystOutput, preClassifyTier, type RequirementsDocJson } from './analyst-executor.js';
import { validateContractTests, type ValidationReport } from './contract-test-validator.js';
import { verifyRedState, cleanupRedCheckFiles, type RedCheckResult } from './contract-test-red-check.js';
import { buildRevisionPrompt } from './analyst-prompt.js';

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

    // 1c. DB dedup: reuse recent valid analysis for same channel (0 token cost)
    try {
      const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
      const existingDoc = await prisma.requirementsDoc.findFirst({
        where: {
          sourceChannelId: channelId,
          createdAt: { gte: new Date(Date.now() - REUSE_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        const acGroups = JSON.parse(existingDoc.acGroups || '[]');
        const hasQuality =
          Array.isArray(acGroups) && acGroups.length > 0 &&
          acGroups.every((g: Record<string, unknown>) =>
            typeof g?.id === 'string' &&
            Array.isArray(g?.acs) && (g.acs as unknown[]).length > 0
          );
        if (hasQuality) {
          const response: RequirementsDocJson = {
            requirement: {
              title: existingDoc.title, summary: '',
              acGroups, tags: JSON.parse(existingDoc.tags || '[]'), constraints: [],
            },
            design: { acGroups: [] },
            task: { acGroups: acGroups.map((g: Record<string, unknown>) => ({ id: g.id as string })) },
          };
          logger.info('[AnalystTrigger] Reusing existing valid analysis (0 token)', {
            channelId, docId: existingDoc.id,
            ageMin: Math.round((Date.now() - existingDoc.createdAt.getTime()) / 60000),
          });

          // Post reuse notice
          await channelMessageService.createAgentMessage(channelId, 'Analyst',
            `♻️ 复用已有分析（0 token 消耗）: ${existingDoc.title}`,
            { meta: { requirementsDocId: existingDoc.id } });

          // Write SDD files from cached doc
          const slug = toKebab(existingDoc.title || 'analysis');
          try {
            const now = new Date().toISOString();
            const allFiles = [...new Set(acGroups.flatMap((g: any) => g.files || []).filter(Boolean)
              .map((f: string) => f.replace(/:L?\d+(-L?\d+)?$/, '')))];
            writeSddDoc(slug, 'requirement', {
              id: existingDoc.id, goalId: existingDoc.goalId || undefined, slug,
              title: existingDoc.title, status: 'draft',
              tier: (response.requirement.tier as any) || 'standard',
              version: 1, requirementVersion: 1, designVersion: 1, taskVersion: 1,
              sourceChannelId: channelId, tags: response.requirement.tags || [],
              createdAt: now, updatedAt: now,
            }, [
              `## ${existingDoc.title}`, '',
              ...response.requirement.acGroups.flatMap((g: any) => [
                `### ${g.id}`, '', '#### 验收标准',
                ...g.acs.map((ac: string) => `- [ ] ${ac}`), '',
                '#### 涉及文件', ...(g.files?.length ? g.files.map((f: string) => `- ${f}`) : ['- N/A']), '',
              ]),
              '', '## Files', '', ...allFiles.map((f: string) => `- ${f}`),
            ].join('\n'));
            appendChangelog(slug, `Reused from cached analysis (channel: ${channelId}, doc: ${existingDoc.id})`);
          } catch (e) { logger.warn('[AnalystTrigger] SDD write failed on reuse (non-blocking)', { error: String(e) }); }

          // Post card + auto-start
          const cardMsg = await channelMessageService.createCardMessage(
            channelId, 'Analyst', this.formatCardContent(response), 'requirements_doc',
            { requirementsDocId: existingDoc.id, sddSlug: slug },
          );
          eventBus.publish('channel.requirements_ready', { channelId, requirementsDocId: existingDoc.id });
          this.autoStartExecution(channelId, cardMsg.id).catch((e: any) => {
            logger.warn('[AnalystTrigger] Auto-start on reused doc failed', { error: String(e) });
          });
          return; // exit trigger — skip LLM entirely
        }
      }
    } catch (e) {
      logger.warn('[AnalystTrigger] DB dedup check failed, proceeding with LLM', { error: String(e) });
    }

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
      let outputFile = perInvocationOutputFile();
      logger.info('[AnalystTrigger] Route decision', {
        channelId,
        tier: preTier,
        route: preTier === 'fast' ? 'direct' : 'scout+synth',
        contentLength: content.length,
      });

      let route = 'direct';
      let scoutMetrics = { prescanMs: 0, scoutParallelMs: 0, scoutTotalMs: 0, synthMs: 0, scoutCount: 0 };
      let response!: RequirementsDocJson;
      let usage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
      let preAnalystDurationMs = 0;

      if (preTier !== 'fast') {
        // ── Scout+Synth path (non-fast tiers) ──
        try {
          const { preScan } = await import('./analyst-prescan.js');
          const scoutModule = await import('./analyst-scout.js');
          const buildScoutPrompts = scoutModule.buildScoutPrompts;
          const { buildSynthesizerPrompt } = await import('./analyst-synthesizer.js');

          const repoDir = process.env.REPO_DIR || process.cwd();
          const prescanStart = Date.now();
          const scope = preScan(content, repoDir);
          const prescanMs = Date.now() - prescanStart;

          const scoutPrompts = buildScoutPrompts(scope, content);
          const scoutStart = Date.now();

          // Point 7: Scouts dispatched
          logger.info('[AnalystScout] Scouts dispatched', {
            channelId,
            scoutCount: scoutPrompts.length,
            types: scoutPrompts.map(s => s.type),
            scopeModules: scope.modules.length,
            scopeFiles: scope.keyFiles.length,
          });

          const scoutResults = await Promise.allSettled(
            scoutPrompts.map(async (s) => {
              const scoutOutputFile = `.analyst/scout-${s.type}-${Date.now()}.json`;
              const result = await daemon.submitAdhocJob({
                prompt: s.prompt,
                outputFile: scoutOutputFile,
              }, { worktree: repoDir, modelTier: 'fast' });
              return { type: s.type, ...result };
            })
          );

          const scoutReports = scoutPrompts.map((s, i) => {
            const settled = scoutResults[i];
            if (settled.status === 'fulfilled') {
              return {
                type: s.type, success: settled.value.success,
                content: settled.value.output || '', durationMs: Date.now() - scoutStart,
                error: settled.value.error,
              };
            }
            return {
              type: s.type, success: false, content: '',
              durationMs: Date.now() - scoutStart, error: String(settled.reason),
            };
          });

          logger.info('[AnalystScout] Scouts completed', {
            channelId,
            total: scoutReports.length,
            success: scoutReports.filter(r => r.success).length,
            failed: scoutReports.filter(r => !r.success).length,
            types: scoutReports.map(r => r.type),
            perScout: scoutReports.map(r => ({ type: r.type, success: r.success, durationMs: r.durationMs, error: r.error })),
          });

          const allFailed = scoutReports.every(r => !r.success);
          if (allFailed) {
            logger.warn('[AnalystTrigger] All scouts failed — falling back to direct path');
            throw new Error('All scouts failed');
          }

          // Synthesizer session
          const synthPrompt = buildSynthesizerPrompt(
            content, scope, scoutReports.filter(r => r.success), outputFile,
          );
          const synthStart = Date.now();
          let synthResult = await runClaudeCode(synthPrompt, outputFile, undefined, 'premium');
          // outputLen=0 guard: model may complete turns without producing text
          if (!synthResult.doc) {
            logger.warn('[AnalystSynth] Empty output, retrying once', { channelId });
            outputFile = perInvocationOutputFile();
            synthResult = await runClaudeCode(synthPrompt, outputFile, undefined, 'premium');
          }
          response = synthResult.doc;
          usage = synthResult.usage;
          route = 'scout+synth';

          // Point 9: Synthesis completed
          logger.info('[AnalystSynth] Synthesis completed', {
            channelId,
            synthMs: Date.now() - synthStart,
            synthInputTokens: synthResult.usage.inputTokens,
            synthOutputTokens: synthResult.usage.outputTokens,
            synthCacheHitTokens: synthResult.usage.cacheHitTokens,
            scoutInputCount: scoutReports.filter(r => r.success).length,
            acGroupCount: synthResult.doc.requirement.acGroups?.length || 0,
          });

          scoutMetrics = {
            prescanMs, scoutParallelMs: Date.now() - scoutStart,
            scoutTotalMs: scoutReports.reduce((sum, r) => sum + r.durationMs, 0),
            synthMs: Date.now() - synthStart, scoutCount: scoutReports.length,
          };
        } catch (scoutErr) {
          logger.warn('[AnalystTrigger] Scout path failed, falling back to direct', { error: String(scoutErr) });
          route = 'direct';
          scoutMetrics = { prescanMs: 0, scoutParallelMs: 0, scoutTotalMs: 0, synthMs: 0, scoutCount: 0 };
          // Fall through to direct path below
        }
      }

      if (route === 'direct') {
        // ── Fast tier direct path (existing single-session) ──
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
        preAnalystDurationMs = Date.now() - preAnalystStart;

        const isSimpleTask = content.length < 500 && !/(schema|migration|migrate|auth|new\s+module|架构重构)/i.test(content);
        const claudeArgs = isSimpleTask ? ['--allowedTools', 'Bash,Edit,Read,Grep'] : undefined;
        let result = await runClaudeCode(prompt, outputFile, claudeArgs, 'premium');
        // outputLen=0 guard: model may complete turns without producing text
        if (!result.doc) {
          logger.warn('[AnalystTrigger] Empty output, retrying once', { channelId });
          outputFile = perInvocationOutputFile();
          result = await runClaudeCode(prompt, outputFile, claudeArgs, 'premium');
        }
        response = result.doc;
        usage = result.usage;
      }

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

      // ContractTest quality validation (Layer 1-4) with revision loop
      const MAX_REVISION_ROUNDS = 2;
      const worktree = process.env.REPO_DIR || process.cwd();
      let contractTestValidationPassed = false;
      let revisionRound = 0;
      let lastValidationReport: ValidationReport | null = null;
      let lastRedCheckResult: RedCheckResult | null = null;

      while (!contractTestValidationPassed && revisionRound <= MAX_REVISION_ROUNDS) {
        // Layer 1-3: Deterministic checks
        const validationReport = validateContractTests(
          response.requirement.acGroups,
          response.task.acGroups,
          worktree,
        );
        lastValidationReport = validationReport;

        // CT-4 monitoring: Revision loop start
        if (revisionRound > 0) {
          logger.info('[ContractTest] Revision', {
            channelId,
            round: revisionRound,
            triggerLayers: [
              !validationReport.layer1.every(l => l.pass) ? '1' : null,
              !validationReport.layer2.every(l => l.pass) ? '2' : null,
              !validationReport.layer3.every(l => l.pass) ? '3' : null,
            ].filter(Boolean),
            previousFailures: lastValidationReport ? [
              ...lastValidationReport.layer1.filter(l => !l.pass).map(l => `L1:${l.acGroupId}`),
              ...lastValidationReport.layer2.filter(l => !l.pass).map(l => `L2:${l.testFile}`),
              ...lastValidationReport.layer3.filter(l => !l.pass).map(l => `L3:${l.testFile}`),
            ] : [],
          });
        }

        // Check if Layer 1-3 passed
        const layer123Pass = validationReport.layer1.every(l => l.pass)
          && validationReport.layer2.every(l => l.pass)
          && validationReport.layer3.every(l => l.pass);

        if (!layer123Pass) {
          // Build gate issues for revision
          const gateIssues: string[] = [];
          for (const l of validationReport.layer1.filter(l => !l.pass)) {
            gateIssues.push(`acGroup ${l.acGroupId}: AC coverage ${(l.coverageRate * 100).toFixed(0)}% < 60%, uncovered ACs: ${l.uncoveredAcs.join(', ')}`);
          }
          for (const l of validationReport.layer2.filter(l => !l.pass)) {
            gateIssues.push(`test file ${l.testFile}: TypeScript syntax errors: ${l.syntaxErrors.map(e => e.message).join('; ')}`);
          }
          for (const l of validationReport.layer3.filter(l => !l.pass)) {
            const unresolved = l.importPaths.filter(p => !p.resolved);
            gateIssues.push(`test file ${l.testFile}: unresolved imports: ${unresolved.map(p => p.path).join(', ')}`);
          }

          if (revisionRound >= MAX_REVISION_ROUNDS) {
            logger.warn('[ContractTest] Revision limit reached, proceeding with warnings', {
              channelId,
              revisionRound,
              gateIssues,
            });
            // CT-4 monitoring: Revision failed
            logger.info('[ContractTest] Revision', {
              channelId,
              round: revisionRound,
              status: 'max_rounds_reached',
              gateIssues,
            });
            break;
          }

          // Trigger revision
          revisionRound++;
          logger.info('[ContractTest] Revision', {
            channelId,
            round: revisionRound,
            triggerLayer: '1-3',
            gateIssues,
          });

          try {
            const revisionPrompt = buildRevisionPrompt(
              content,
              gateIssues,
              JSON.stringify(response, null, 2),
              revisionRound,
            );

            const revisionResult = await runClaudeCode(
              revisionPrompt,
              perInvocationOutputFile(),
              undefined,
              'premium',
            );

            // Guard: only overwrite response if revision produced valid output
            if (revisionResult.doc) {
              response = revisionResult.doc;
              usage = {
                inputTokens: usage.inputTokens + revisionResult.usage.inputTokens,
                outputTokens: usage.outputTokens + revisionResult.usage.outputTokens,
                cacheHitTokens: usage.cacheHitTokens + revisionResult.usage.cacheHitTokens,
              };

              // Re-validate structure
              const newErrors = validateAnalystOutput(response);
              if (newErrors.length > 0) {
                logger.error('[ContractTest] Revision output validation failed', {
                  channelId,
                  round: revisionRound,
                  errors: newErrors,
                });
                break;
              }
            } else {
              // Revision produced no output — stop revision loop, keep synth's original data
              logger.warn('[AnalystTrigger] Revision produced no output, stopping revision loop', {
                channelId,
                round: revisionRound,
              });
              break;
            }
          } catch (e) {
            logger.error('[ContractTest] Revision failed', {
              channelId,
              round: revisionRound,
              error: String(e),
            });
            break;
          }
          continue;
        }

        // Layer 4: RED verification (only if there are contractTests to verify)
        const allContractTests = response.task.acGroups.flatMap(g => g.contractTests || []);
        if (allContractTests.length === 0) {
          // No contractTests, skip RED check
          contractTestValidationPassed = true;
          break;
        }

        const redCheckResult = verifyRedState({
          acGroupId: 'all',
          contractTests: allContractTests,
          worktree,
          timeout: 60_000,
        });
        lastRedCheckResult = redCheckResult;

        if (!redCheckResult.overallRed) {
          // Tests passed when they should fail — not RED state
          const gateIssues: string[] = [];
          for (const f of redCheckResult.files.filter(f => !f.isRed)) {
            gateIssues.push(`test file ${f.file}: expected RED (failure) but got ${f.failureType} (exitCode=${f.exitCode})`);
          }

          if (revisionRound >= MAX_REVISION_ROUNDS) {
            logger.warn('[ContractTest] RED verification failed, revision limit reached', {
              channelId,
              revisionRound,
              gateIssues,
            });
            // CT-4 monitoring
            logger.info('[ContractTest] Revision', {
              channelId,
              round: revisionRound,
              status: 'red_check_failed_max_rounds',
              gateIssues,
            });
            break;
          }

          // Trigger revision for RED failure
          revisionRound++;
          logger.info('[ContractTest] Revision', {
            channelId,
            round: revisionRound,
            triggerLayer: '4',
            reason: 'RED verification failed',
            gateIssues,
          });

          try {
            const revisionPrompt = buildRevisionPrompt(
              content,
              gateIssues,
              JSON.stringify(response, null, 2),
              revisionRound,
            );

            const revisionResult = await runClaudeCode(
              revisionPrompt,
              perInvocationOutputFile(),
              undefined,
              'premium',
            );

            if (revisionResult.doc) {
              response = revisionResult.doc;
              usage = {
                inputTokens: usage.inputTokens + revisionResult.usage.inputTokens,
                outputTokens: usage.outputTokens + revisionResult.usage.outputTokens,
                cacheHitTokens: usage.cacheHitTokens + revisionResult.usage.cacheHitTokens,
              };

              const newErrors = validateAnalystOutput(response);
              if (newErrors.length > 0) {
                logger.error('[ContractTest] Revision output validation failed', {
                  channelId,
                  round: revisionRound,
                  errors: newErrors,
                });
                break;
              }
            } else {
              logger.warn('[AnalystTrigger] Revision produced no output, stopping revision loop', {
                channelId,
                round: revisionRound,
              });
              break;
            }
          } catch (e) {
            logger.error('[ContractTest] Revision failed', {
              channelId,
              round: revisionRound,
              error: String(e),
            });
            break;
          }
          continue;
        }

        // All checks passed
        contractTestValidationPassed = true;

        // Cleanup RED check files
        cleanupRedCheckFiles(worktree, allContractTests);
      }

      // CT-5 monitoring: Final quality summary
      const totalAcs = response.requirement.acGroups.reduce((sum, g) => sum + g.acs.length, 0);
      const finalCoverageRate = lastValidationReport
        ? lastValidationReport.layer1.reduce((sum, l) => sum + l.coveredAcs, 0) / Math.max(totalAcs, 1)
        : 0;

      logger.info('[ContractTest] Final Quality', {
        channelId,
        totalAcs,
        finalCoverageRate: `${(finalCoverageRate * 100).toFixed(1)}%`,
        revisionRounds: revisionRound,
        allPassed: contractTestValidationPassed,
        layer1Pass: lastValidationReport?.layer1.every(l => l.pass) ?? false,
        layer2Pass: lastValidationReport?.layer2.every(l => l.pass) ?? false,
        layer3Pass: lastValidationReport?.layer3.every(l => l.pass) ?? false,
        layer4Red: lastRedCheckResult?.overallRed ?? false,
      });

      // 5. Save RequirementsDoc to DB
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
            '#### 验收标准',
            ...g.acs.map((ac: string) => `- [ ] ${ac}`),
            '',
            '#### 涉及文件',
            ...(g.files?.length ? g.files.map((f: string) => `- ${f}`) : ['- N/A']),
            '',
            `#### 依赖${g.dependencies?.length ? ': ' + g.dependencies.join(', ') : ''}`,
            '',
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
      if (route === 'direct') {
        // 9a. Pre-analyst knowledge search (0 tokens, duration only)
        recordPipelineRun({
          source: 'pipeline', phase: 'analyst',
          taskName: `pre-analyst:${response.requirement.title || '需求分析'}`,
          model: 'knowledge-search',
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
          durationMs: preAnalystDurationMs,
          success: true,
          sessionId: doc.id,
        }).catch((e: unknown) => {
          logger.error('[AnalystTrigger] Pre-analyst metrics FAILED', { error: String(e) });
        });
      }

      // 9b. Analyst Claude session (direct: full session; scout+synth: synthesizer only)
      recordPipelineRun({
        source: 'pipeline', phase: 'analyst',
        taskName: response.requirement.title || '需求分析',
        model: `claude-${preTier}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        durationMs: route === 'scout+synth' ? scoutMetrics.synthMs : durationMs - preAnalystDurationMs,
        success: true,
        sessionId: doc.id,
      }).catch((e: unknown) => {
        logger.error('[AnalystTrigger] PipelineRun record FAILED', { error: String(e), docId: doc.id });
      });

      // Point 12 (analyst-specific): B52 attribution with scoutRoute flag
      logger.info('[Pipeline] B52 attribution', {
        phase: 'analyst',
        channelId,
        goalId: doc.id,
        perExecutionSession: true,
        emptyDiffReject: true,
        noAcGroupMerge: true,
        scoutRoute: route === 'scout+synth',
        actualTokens: usage.inputTokens + usage.outputTokens,
        actualDurationMs: durationMs,
      });

      logger.info('[AnalystTrigger] Phase complete', {
        channelId,
        route,
        totalMs: durationMs,
        tokens: usage,
        ...(route === 'scout+synth' ? scoutMetrics : {}),
      });

      logger.info('[AnalystTrigger] RequirementsDoc generated', {
        channelId, docId: doc.id, acGroupCount: response.requirement.acGroups?.length || 0,
        durationMs, route, dbKnowledgeSize: dbKnowledge.length,
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
