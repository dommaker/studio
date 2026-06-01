/**
 * Knowledge Agent - 从执行结果中异步提取知识
 *
 * 被动模式：Executor 完成后自动触发，从 git diff + 测试结果中抽取知识。
 * 使用 harness KnowledgeStore + KnowledgeIngest 存储。
 */

import { modelGateway, logger } from '@dommaker/studio-shared';
import { ColdStartImporter, KnowledgeLinter, ReferenceTracker } from '@dommaker/harness';
import { sharedStore, sharedIngest, scheduleVectorDbSync } from '../knowledge/knowledge-bus.service.js';
import { prisma } from '@dommaker/studio-prisma';
import { channelMessageService } from '../channels/channel-message.service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import type { KnowledgeExtraction } from './types.js';

const execAsync = promisify(exec);
const sharedLinter = new KnowledgeLinter(sharedStore, new ReferenceTracker(sharedStore));

const KNOWLEDGE_SYSTEM_PROMPT = `你是一个知识提取专家。请从以下代码变更和执行结果中提取有价值的知识条目。

每个知识条目应包含：
- type: "decision"（设计决策）| "pitfall"（踩坑记录）| "guideline"（最佳实践）| "model"（架构模式）| "architecture"（架构决策）| "process"（流程改进）
- title: 简洁标题（应概括根因而非现象，如"缺少 uuid 声明导致运行时崩溃"而非"启动失败"）
- content: 详细描述，必须包含三层分析：
  1. 根因（为什么发生？不要停留在表面现象）
  2. 责任归属（哪个 Agent/流程应该预防这个问题？Review/Monitor/Auditor/Executor/Deploy？）
  3. 预防建议（具体可操作的改进措施）
- tags: 相关标签（含根因标签如 phantom-dependency, ghost-dependency, missing-import）

请严格以 JSON 格式返回：
{
  "entries": [
    { "type": "...", "title": "...", "content": "...", "tags": ["..."] }
  ]
}

提取规则：
- 只提取有价值的、可复用的知识，不要提取显而易见的事实
- 失败任务重点提取 pitfall（踩坑记录）
- 成功任务重点提取 decision（设计决策）和 guideline（最佳实践）
- content 必须做根因分析，不能只描述现象
- 如果没有值得提取的知识，返回空数组
- 最多提取 5 个条目`;

export class KnowledgeAgent {

  /**
   * P1b: Four-source cold start import
   * 1. Docs: memory/*.md + CLAUDE.md + README.md (layer: 'system', types: architecture/process/decision)
   * 2. Code: package.json + tsconfig.json (layer: 'tech', types: model)
   * 3. Git: recent refactor/fix commits (layer: 'project', types: pitfall/guideline)
   * 4. Manual: pipeline flow, agent responsibilities (layer: 'system', types: process)
   */
  async coldStartAll(): Promise<void> {
    const projectRoot = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');

    try {
      const fs = await import('fs');
      const memoryFiles = await this.getMemoryFiles(memoryDir);
      const docPaths = [
        ...memoryFiles,
        path.join(projectRoot, 'CLAUDE.md'),
        path.join(projectRoot, 'README.md'),
      ].filter(p => {
        try { return fs.existsSync(p); } catch { return false; }
      });

      const importer = new ColdStartImporter({
        projectRoot,
        store: sharedStore,
        sources: ['code', 'git', 'docs', 'manual'],
        docPaths,
        manualEntries: [
          {
            title: 'Pipeline 9-Stage Flow',
            content: 'Plan→Dispatch→Execute→Review→Deploy→PostEval→Audit→Monitor→Triage',
            type: 'process',
            tags: ['pipeline', 'architecture'],
          },
          {
            title: '8-Agent System',
            content: 'Executor/Review/Knowledge/Monitor/Triage/Auditor/PostEval/Deploy',
            type: 'model',
            tags: ['agents', 'system'],
          },
        ],
        skipExisting: true,
      });

      const results = await importer.importAll();
      const importedCount = results.reduce((sum, r) => sum + r.entries.length, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

      logger.info('[KnowledgeAgent] Cold start import completed', {
        importedCount,
        totalErrors,
        sources: results.map(r => r.source.type),
      });

      // Discord notify
      try {
        const { discordNotifier } = await import('../../utils/discord-notifier.js');
        await discordNotifier.sendText(
          '📚 冷启动知识导入完成',
          `导入了 ${importedCount} 条知识 (${totalErrors} 个错误)\n来源: ${results.map(r => `${r.source.type}(${r.entries.length})`).join(', ')}`,
        );
      } catch { /* non-blocking */ }
    } catch (err) {
      logger.error('[KnowledgeAgent] Cold start import failed', { error: String(err) });
    }
  }

  /**
   * 获取 memory 目录下的 markdown 文件列表
   */
  private async getMemoryFiles(memoryDir: string): Promise<string[]> {
    try {
      const fs = await import('fs');
      if (!fs.existsSync(memoryDir)) return [];
      return fs.readdirSync(memoryDir)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(memoryDir, f));
    } catch {
      return [];
    }
  }

  /**
   * 从执行结果中提取知识（异步，不阻塞主流程）
   */
  async extract(params: {
    taskId: string;
    projectId: string;
    worktree: string;
    taskDescription: string;
    result: 'success' | 'failure';
    error?: string;
  }): Promise<void> {
    const { taskId, projectId, worktree, taskDescription, result, error } = params;

    try {
      // 1. 读取 git diff
      const diff = await this.getDiff(worktree);

      // 2. 读取变更文件列表
      const changedFiles = await this.getChangedFiles(worktree);

      // G-004: 架构变更时异步提取决策链（不阻塞主流程）
      if (result === 'success') {
        import('../knowledge/decision-chain-extractor.js').then(({ decisionChainExtractor }) => {
          decisionChainExtractor.extractFromExecution({
            taskId,
            projectId,
            taskDescription,
            changedFiles,
            diff: diff || undefined,
          }).catch(() => { /* non-blocking */ });
        }).catch(() => { /* non-blocking */ });
      }

      if (!diff && changedFiles.length === 0 && result === 'success') {
        logger.info('[KnowledgeAgent] No changes to extract from, skipping', { taskId });
        return;
      }

      // 3. 构建知识抽取 prompt
      const prompt = `## 任务
${taskDescription}

## 执行结果
状态: ${result === 'success' ? '成功' : '失败'}
${error ? `错误信息: ${error}` : ''}

## 变更文件
${changedFiles.join('\n') || '无文件变更'}

## Git Diff（截取前 4000 字符）
\`\`\`diff
${diff?.substring(0, 4000) || '无 diff'}
\`\`\`

请从中提取有价值的知识条目。`;

      // 4. LLM 抽取
      const extraction = await modelGateway.promptJson<KnowledgeExtraction>(prompt, KNOWLEDGE_SYSTEM_PROMPT);

      if (!extraction.entries?.length) {
        logger.info('[KnowledgeAgent] No knowledge extracted', { taskId });
        return;
      }

      // 5. 推送确认卡片到 #系统 Channel（B1-008: KK @human 确认）
      const sysChannel = await this.getOrCreateSystemChannel();
      if (!sysChannel) {
        logger.warn('[KnowledgeAgent] #系统 channel not found, falling back to direct write', { taskId });
        this.writeEntriesDirect(extraction.entries, taskId, projectId);
        return;
      }

      const confirmPrompt = extraction.entries.length === 1
        ? `发现 1 条知识，请确认是否入库`
        : `发现 ${extraction.entries.length} 条知识，请确认是否入库`;

      const entryList = extraction.entries
        .map((e, i) => `**${i + 1}. ${e.title}** [${e.type}]\n${e.content}\n标签: ${e.tags?.join(', ') || '无'}`)
        .join('\n\n');

      await channelMessageService.createCardMessage(
        sysChannel.id,
        'KK',
        `${confirmPrompt}:\n\n${entryList}`,
        'knowledge_confirm',
        {
          entries: extraction.entries,
          taskId,
          projectId,
          source: `task:${taskId}`,
        },
      );

      logger.info('[KnowledgeAgent] Confirmation card pushed to #系统', {
        taskId,
        entryCount: extraction.entries.length,
        types: extraction.entries.map(e => e.type),
      });
    } catch (err) {
      // 知识提取失败不影响主流程
      logger.error('[KnowledgeAgent] Extraction failed', { taskId, error: String(err) });
    }
  }

  /**
   * P0a-1: 从审查结果中提取可复用知识
   */
  async extractFromReview(
    reviewResult: { approved: boolean; score: number; issues: Array<{ severity: string; message: string; file?: string; line?: number }>; suggestions: string[] },
    taskId: string,
    projectId: string,
  ): Promise<void> {
    try {
      // Part D: Resolve PMO number for knowledge tagging
      let pmoTag = '';
      try {
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pmoNumber: true } });
        if (project?.pmoNumber) pmoTag = `pmo:${project.pmoNumber}`;
      } catch { /* best-effort */ }

      const prompt = `## 审查结果
状态: ${reviewResult.approved ? '通过' : '未通过'}
评分: ${reviewResult.score}/100
问题数: ${reviewResult.issues.length}

## 发现的问题
${reviewResult.issues.map(i => `- [${i.severity}] ${i.message}${i.file ? ` (${i.file}:${i.line || '?'})` : ''}`).join('\n') || '无'}

## 改进建议
${reviewResult.suggestions.map(s => `- ${s}`).join('\n') || '无'}

请从中提取可复用的踩坑记录(pitfall)和最佳实践(guideline)。`;

      const extraction = await modelGateway.promptJson<KnowledgeExtraction>(prompt, KNOWLEDGE_SYSTEM_PROMPT);
      if (!extraction.entries?.length) return;

      for (const entry of extraction.entries) {
        const tags = [...(entry.tags || []), ...(pmoTag ? [pmoTag] : [])];
        this.safeIngest(
          { type: entry.type as any, title: entry.title, content: entry.content, tags, projects: [projectId] },
          { source: `review:${taskId}`, layer: 'project', maturity: 'draft', tags, projects: [projectId] },
        );
      }
      logger.info('[KnowledgeAgent] Extracted from review', { taskId, entryCount: extraction.entries.length, pmoTag: pmoTag || 'none' });
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractFromReview failed', { taskId, error: String(err) });
    }
  }

  /**
   * P0a-2: 从失败任务的错误中提取踩坑记录
   */
  async extractFromError(
    error: string,
    errorChain: string,
    taskDescription: string,
    taskId: string,
    projectId: string,
  ): Promise<void> {
    try {
      const prompt = `## 任务描述
${taskDescription}

## 错误信息
${error.slice(0, 2000)}

## 错误上下文
${errorChain.slice(0, 2000)}

请从这些失败信息中提取踩坑记录(pitfall)，帮助避免同类错误。`;

      const extraction = await modelGateway.promptJson<KnowledgeExtraction>(
        prompt,
        '你是故障分析专家。从失败任务中提取踩坑记录(pitfall)。对每条记录必须做根因分析：1) 根本原因是什么（不描述表面现象），2) 哪个 Agent/流程应该预防这个问题，3) 具体可操作的预防措施。如果没有值得提取的知识，返回空数组。最多提取 3 个条目。输出格式：{ "entries": [{ "type": "pitfall", "title": "根因概括", "content": "根因+责任+预防", "tags": ["根因标签"] }] }',
      );
      if (!extraction.entries?.length) return;
      if (!extraction.entries?.length) return;

      for (const entry of extraction.entries) {
        this.safeIngest(
          { type: 'pitfall', title: entry.title, content: entry.content, tags: entry.tags, projects: [projectId] },
          { source: `error:${taskId}`, layer: 'project', maturity: 'draft', tags: [...(entry.tags || []), 'error'], projects: [projectId] },
        );
      }
      logger.info('[KnowledgeAgent] Extracted from error', { taskId, entryCount: extraction.entries.length });
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractFromError failed', { taskId, error: String(err) });
    }
  }

  /**
   * P0a-3: 从执行完成输出中提取设计决策和最佳实践
   */
  async extractFromCompletion(
    completionOutput: Record<string, any>,
    taskId: string,
    projectId: string,
  ): Promise<void> {
    try {
      const prompt = `## 变更文件
${(completionOutput.changedFiles || []).join('\n') || '无'}

## 完成的 AC
${(completionOutput.completedAcs || []).join('\n') || '无'}

## @sibling 建议
${(completionOutput.siblingAdvice || []).map((a: any) => `- Target: ${a.targetGroupId}, Priority: ${a.priority}, Message: ${a.message}`).join('\n') || '无'}

## 会话数
${completionOutput.sessionCount || '?'}

请从执行完成输出中提取设计决策(decision)和最佳实践(guideline)。`;

      const extraction = await modelGateway.promptJson<KnowledgeExtraction>(prompt, KNOWLEDGE_SYSTEM_PROMPT);
      if (!extraction.entries?.length) return;

      for (const entry of extraction.entries) {
        this.safeIngest(
          { type: entry.type as any, title: entry.title, content: entry.content, tags: entry.tags, projects: [projectId] },
          { source: `completion:${taskId}`, layer: 'project', maturity: 'draft', tags: entry.tags, projects: [projectId] },
        );
      }
      logger.info('[KnowledgeAgent] Extracted from completion', { taskId, entryCount: extraction.entries.length });
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractFromCompletion failed', { taskId, error: String(err) });
    }
  }

  /**
   * P0a-4: 从部署结果中提取部署相关的踩坑和最佳实践
   */
  async extractFromDeploy(
    deployResult: { success: boolean; type: string; findings: Array<{ severity: string; category: string; message: string }>; summary: string; artifact?: string },
    taskId: string,
    projectId: string,
  ): Promise<void> {
    try {
      // Part D: Resolve PMO number for knowledge tagging
      let pmoTag = '';
      try {
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pmoNumber: true } });
        if (project?.pmoNumber) pmoTag = `pmo:${project.pmoNumber}`;
      } catch { /* best-effort */ }

      const prompt = `## 部署结果
成功: ${deployResult.success ? '是' : '否'}
类型: ${deployResult.type}
${deployResult.artifact ? `制品: ${deployResult.artifact}` : ''}

## 部署发现
${deployResult.findings.map(f => `- [${f.severity}] (${f.category}) ${f.message}`).join('\n') || '无'}

## 摘要
${deployResult.summary.slice(0, 2000)}

请从部署结果中提取部署相关的踩坑记录(pitfall)和最佳实践(guideline)。`;

      const extraction = await modelGateway.promptJson<KnowledgeExtraction>(
        prompt,
        '你是一个部署运维专家。从部署结果中提取可复用的部署知识和踩坑记录。如果没有值得提取的知识，返回空数组。最多提取 3 个条目。输出格式：{ "entries": [{ "type": "pitfall", "title": "...", "content": "...", "tags": ["..."] }] }',
      );
      if (!extraction.entries?.length) return;

      for (const entry of extraction.entries) {
        const tags = [...(entry.tags || []), 'deploy', ...(pmoTag ? [pmoTag] : [])];
        this.safeIngest(
          { type: entry.type as any, title: entry.title, content: entry.content, tags, projects: [projectId] },
          { source: `deploy:${taskId}`, layer: 'project', maturity: 'draft', tags, projects: [projectId] },
        );
      }
      logger.info('[KnowledgeAgent] Extracted from deploy', { taskId, entryCount: extraction.entries.length, pmoTag: pmoTag || 'none' });
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractFromDeploy failed', { taskId, error: String(err) });
    }
  }

  /**
   * P0b: Extract knowledge from arbitrary text content (generic API)
   *
   * Studio's public interface for knowledge extraction from any text source.
   * Source-specific preprocessing (format parsing, message filtering, truncation)
   * belongs in the caller, not here.
   *
   * @param content - Raw text to extract knowledge from
   * @param source - Identifier for the source (e.g. "chat:20260522", "discord:channel:123")
   * @param layer - Storage layer (default: 'system')
   */
  async extractFromText(
    content: string,
    source: string,
    layer: 'project' | 'system' | 'tech' | 'team' | 'domain' | 'personal' = 'system',
  ): Promise<void> {
    try {
      if (!content || content.trim().length === 0) {
        logger.info('[KnowledgeAgent] Empty text, skipping extraction', { source });
        return;
      }

      // Direct API call for knowledge extraction
      const apiKey = process.env.KNOWLEDGE_API_KEY || process.env.STUDIO_API_KEY || '';
      if (!apiKey) {
        logger.warn('[KnowledgeAgent] No API key (KNOWLEDGE_API_KEY or STUDIO_API_KEY), skipping extraction', { source });
        return;
      }

      const truncatedContent = content.slice(0, 50_000);
      logger.info('[KnowledgeAgent] extractFromText starting', {
        source: source.slice(-40),
        contentLength: truncatedContent.length,
        originalLength: content.length,
      });

      const rawResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: `你是知识提取专家。从文本中提取结构化知识。对每条记录必须做三层分析：1) 根因（不描述表面现象），2) 责任归属（哪个 Agent/流程该预防），3) 预防措施（具体可操作）。\n\n关注类型：\n- 架构决策 (architecture) - 关于系统设计的讨论和决定\n- 设计决策 (decision) - 关于实现方式的取舍\n- 踩坑记录 (pitfall) - 遇到的问题，重点是根因而非现象\n- 流程经验 (process) - 流程中哪个环节该改进\n- 最佳实践 (guideline) - 可复用的经验和模式\n\n输出格式：{ "entries": [{ "type": "architecture|decision|pitfall|process|guideline", "title": "根因概括", "content": "根因+责任+预防", "tags": ["标签"] }] }\n只提取有价值的、可复用的知识。没有值得提取的知识则返回空数组。最多提取 5 个条目。` },
            { role: 'user', content: truncatedContent },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });

      if (!rawResponse.ok) {
        const errorBody = await rawResponse.text().catch(() => 'unreadable');
        logger.warn('[KnowledgeAgent] DeepSeek API error', {
          source: source.slice(-40),
          status: rawResponse.status,
          body: errorBody.slice(0, 300),
        });
        return;
      }

      const data = await rawResponse.json() as any;
      const llmContent = data.choices?.[0]?.message?.content || '';
      const finishReason = data.choices?.[0]?.finish_reason;

      logger.info('[KnowledgeAgent] DeepSeek response received', {
        source: source.slice(-40),
        responseLength: llmContent.length,
        finishReason,
        preview: llmContent.slice(0, 200),
      });

      if (!llmContent) {
        logger.info('[KnowledgeAgent] Empty LLM response for extraction', { source: source.slice(-40) });
        return;
      }

      // Parse JSON from LLM response — try 3 strategies:
      // 1. Direct parse (fast path)
      // 2. Markdown code block extraction
      // 3. First {...} object in response (handles tool_calls wrapping, preamble, etc.)
      let result: any;
      try {
        result = JSON.parse(llmContent);
      } catch {
        const codeMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeMatch?.[1]) {
          try { result = JSON.parse(codeMatch[1].trim()); } catch {}
        }
        if (!result) {
          const jsonMatch = llmContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { result = JSON.parse(jsonMatch[0]); } catch {}
          }
        }
        if (!result) {
          logger.warn('[KnowledgeAgent] Failed to parse extraction JSON', { source: source.slice(-40), preview: llmContent.slice(0, 200) });
          return;
        }
      }

      if (!result.entries?.length) {
        logger.info('[KnowledgeAgent] No knowledge extracted from text', {
          source: source.slice(-40),
          llmResponsePreview: llmContent.slice(0, 300),
          parsedKeys: Object.keys(result),
        });
        return;
      }

      // Ingest entries
      for (const entry of result.entries) {
        this.safeIngest(
          {
            type: entry.type as any,
            title: entry.title,
            content: entry.content,
            tags: entry.tags || [],
          },
          {
            source,
            layer: layer as any,
            maturity: 'draft',
            tags: entry.tags || [],
          },
        );
      }

      logger.info('[KnowledgeAgent] Extracted from text', {
        source: source.slice(-60),
        entryCount: result.entries.length,
        types: result.entries.map((e: any) => e.type),
      });

      // B10-101: ChannelMessage + Discord webhook notification
      try {
        const sysChannel = await this.getOrCreateSystemChannel();
        if (sysChannel) {
          const entrySummary = result.entries
            .map((e: any) => `- [${e.type}] ${e.title}`)
            .join('\n');
          await channelMessageService.createAgentMessage(sysChannel.id, 'KK',
            `从 ${source.slice(-40)} 提取了 ${result.entries.length} 条知识:\n${entrySummary}`,
            { meta: { cardType: 'knowledge_extracted', source, entryCount: result.entries.length } },
          );
        }
        const { discordNotifier: dn } = await import('../../utils/discord-notifier.js');
        await dn.sendText(
          `知识提取完成 (${result.entries.length} 条)`,
          `来源: ${source.slice(-40)}\n类型: ${result.entries.map((e: any) => e.type).join(', ')}`,
        );
      } catch { /* non-blocking */ }
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractFromText failed', { source: source.slice(-40), error: String(err) });
    }
  }

  /**
   * KE-003: Extract user behavior patterns from session transcript.
   *
   * Three signal types: correction (user corrects assistant), workflow (decision chain),
   * automation (repeated manual ops). Results stored in UserBehaviorProfile table.
   *
   * Layer 1 context injection: existing profiles + memory rules into prompt to avoid re-extraction.
   *
   * @param content - Preprocessed transcript (filtered + truncated by caller)
   * @param source - "session:<uuid>" identifier
   * @param threshold - Minimum confidence (default 0.6)
   */
  async extractUserBehavior(
    content: string,
    source: string,
    threshold: number = 0.6,
  ): Promise<void> {
    try {
      if (!content || content.trim().length === 0) {
        logger.info('[KnowledgeAgent] Empty transcript, skipping behavior extraction', { source });
        return;
      }

      const apiKey = process.env.KNOWLEDGE_API_KEY || process.env.STUDIO_API_KEY || '';
      if (!apiKey) {
        logger.warn('[KnowledgeAgent] No API key, skipping behavior extraction', { source });
        return;
      }

      // Extract sessionId from source: "session:<uuid>.jsonl.bak..." → "<uuid>"
      const sessionId = source.replace('session:', '').split('.jsonl')[0];

      // Layer 1: inject existing patterns for dedup
      const existingProfiles = await prisma.userBehaviorProfile.findMany({
        select: { title: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const existingTitles = existingProfiles.map(p => p.title);

      // Read memory rules for dedup
      const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
      let memoryRules: string[] = [];
      try {
        const { readdirSync, readFileSync } = await import('fs');
        const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        memoryRules = files.slice(0, 30).map(f => {
          const raw = readFileSync(path.join(memoryDir, f), 'utf-8');
          const titleMatch = raw.match(/^name:\s*(.+)$/m);
          return titleMatch ? titleMatch[1] : f.replace('.md', '');
        });
      } catch { /* non-critical */ }

      const existingPatternsBlock = [
        existingTitles.length > 0 ? `已有行为模式（不要重复提取）:\n${existingTitles.map(t => `- ${t}`).join('\n')}` : '',
        memoryRules.length > 0 ? `已有 memory 规则:\n${memoryRules.map(r => `- ${r}`).join('\n')}` : '',
        '只提取以上未覆盖的新模式。',
      ].filter(Boolean).join('\n\n');

      const systemPrompt = `你是一个行为模式分析师。从以下 Claude Code 会话对话中，提取用户的行为模式。

## 提取维度

### A. 纠正信号（correction）
用户纠正助手的时刻。识别标志：
- 显式纠正："不对"/"应该是"/"你错了"/"先验证"/"不要删"
- 隐式纠正："我感觉你陷入了误区"/"你扫的是哪个工程"/"按照X来判断有点问题"
- 方案推翻：用户否定助手的方案并给出新方向
- 假设质疑：用户质疑助手的前提假设

**不是纠正的情况（负面示例）**：
- 正常指令："先看看待办"/"写个spec" — 这是任务分配，不是纠正
- 信息补充："对，而且还要..." — 这是补充，不是否定
- 确认："可以"/"没问题" — 这是同意

提取：纠正内容 + 触发场景 + 推断的规则

### B. 决策模式（workflow）
用户的决策链。识别标志：
- "先X再Y" / "先看...再做..."
- 用户引导助手的执行顺序
- 用户在多个选项中的选择逻辑
提取：触发条件 + 步骤序列 + 产出物

### C. 重复操作（automation）
用户反复手动执行的操作。识别标志：
- 多次相同请求
- 每次都要确认/查询的东西
- 可以用脚本/hook 替代的手动步骤
提取：操作内容 + 频率 + 自动化价值

## 输出格式（JSON 数组）

[
  {
    "category": "correction|workflow|automation",
    "title": "简短标题（10字以内）",
    "evidence": "原文引用",
    "pattern": "模式描述",
    "suggestedAction": "create_rule|create_skill|create_automation|skip",
    "confidence": 0.0-1.0
  }
]

## 过滤条件

- 只输出 confidence > ${threshold} 的条目
- 只输出以下未覆盖的条目
- 保持简洁，每个条目不超过 3 行

${existingPatternsBlock}`;

      const rawResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: content.slice(0, 40_000) },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
      });
      const data = await rawResponse.json() as any;
      const llmContent = data.choices?.[0]?.message?.content || '';

      if (!llmContent) {
        logger.info('[KnowledgeAgent] Empty LLM response for behavior extraction', { source: source.slice(-40) });
        return;
      }

      // Parse JSON — 4 strategies: direct → codeblock → {...} → [...]
      let profiles: any[] | undefined;
      try {
        const parsed = JSON.parse(llmContent);
        profiles = Array.isArray(parsed) ? parsed : parsed.profiles || parsed.entries;
      } catch {
        const codeMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeMatch?.[1]) {
          try {
            const parsed = JSON.parse(codeMatch[1].trim());
            profiles = Array.isArray(parsed) ? parsed : parsed.profiles || parsed.entries;
          } catch {}
        }
        if (!profiles) {
          const arrMatch = llmContent.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            try { profiles = JSON.parse(arrMatch[0]); } catch {}
          }
        }
        if (!profiles) {
          const objMatch = llmContent.match(/\{[\s\S]*\}/);
          if (objMatch) {
            try {
              const parsed = JSON.parse(objMatch[0]);
              profiles = Array.isArray(parsed) ? parsed : parsed.profiles || parsed.entries;
            } catch {}
          }
        }
        if (!profiles) {
          logger.warn('[KnowledgeAgent] Failed to parse behavior extraction JSON', {
            source: source.slice(-40),
            preview: llmContent.slice(0, 200),
          });
          return;
        }
      }

      if (!profiles?.length) {
        logger.info('[KnowledgeAgent] No behavior patterns extracted', { source: source.slice(-40) });
        return;
      }

      // Store profiles with dedup check
      let stored = 0;
      for (const p of profiles) {
        if (!p.category || !p.title || !p.pattern) continue;
        if (typeof p.confidence === 'number' && p.confidence < threshold) continue;

        // Code-level dedup: title substring match against existing profiles
        const titleNorm = p.title.toLowerCase().trim();
        const alreadyCovered = existingTitles.find(
          t => t.toLowerCase().includes(titleNorm) || titleNorm.includes(t.toLowerCase()),
        );

        await prisma.userBehaviorProfile.create({
          data: {
            sessionId,
            category: p.category,
            title: p.title.slice(0, 100),
            evidence: (p.evidence || '').slice(0, 500),
            pattern: p.pattern.slice(0, 500),
            suggestedAction: p.suggestedAction || 'skip',
            confidence: Math.min(1, Math.max(0, p.confidence || 0.5)),
            alreadyCovered: alreadyCovered || null,
            status: alreadyCovered ? 'rejected' : 'pending',
          },
        });
        stored++;
      }

      logger.info('[KnowledgeAgent] Extracted behavior profiles', {
        source: source.slice(-40),
        total: profiles.length,
        stored,
        skipped: profiles.length - stored,
      });

      // B10-101: ChannelMessage notification for behavior extraction
      if (stored > 0) {
        try {
          const sysChannel = await this.getOrCreateSystemChannel();
          if (sysChannel) {
            const profileSummary = profiles
              .filter((p: any) => p.category && p.title && p.pattern)
              .slice(0, 5)
              .map((p: any) => `- [${p.category}] ${p.title} (置信度: ${Math.round((p.confidence || 0) * 100)}%)`)
              .join('\n');
            await channelMessageService.createAgentMessage(sysChannel.id, 'KK',
              `从会话 ${sessionId.slice(0, 8)} 提取了 ${stored} 条行为模式:\n${profileSummary}`,
              { meta: { cardType: 'behavior_extracted', sessionId, stored, total: profiles.length } },
            );
          }
        } catch { /* non-blocking */ }
      }
    } catch (err) {
      logger.warn('[KnowledgeAgent] extractUserBehavior failed', { source: source.slice(-40), error: String(err) });
    }
  }

  /**
   * 获取或创建 #系统 Channel
   */
  private async getOrCreateSystemChannel(): Promise<{ id: string; name: string } | null> {
    try {
      let channel = await prisma.channel.findUnique({ where: { name: '#系统' } });
      if (!channel) {
        channel = await prisma.channel.create({
          data: { name: '#系统', type: 'system' },
        });
        logger.info('[KnowledgeAgent] Created #系统 channel', { channelId: channel.id });
      }
      return { id: channel.id, name: channel.name };
    } catch (err) {
      logger.error('[KnowledgeAgent] Failed to get/create #系统 channel', { error: String(err) });
      return null;
    }
  }

  /**
   * 直接写入知识库（fallback：当 #系统 Channel 不可用时）
   */
  /**
   * P2.5: Validated ingest — runs quality gate before storing.
   * Same signature as KnowledgeIngest.ingestEntry().
   * Skips entries that fail validation (content too short, vague title, contradiction).
   */
  private safeIngest(
    partial: Partial<{ type: string; title: string; content: string; tags: string[]; projects: string[] }>,
    options: { source: string; layer: string; maturity?: string; tags?: string[]; projects?: string[] },
  ): boolean {
    const entry = { title: partial.title || '', content: partial.content || '', tags: partial.tags || [], type: partial.type || 'guideline' };
    const issues = sharedLinter.validateEntry(entry);

    const blockers = issues.filter(i => i.severity === 'high');
    if (blockers.length > 0) {
      logger.warn('[KnowledgeAgent] Entry rejected by quality gate', {
        title: entry.title,
        issues: blockers.map(i => i.description),
        source: options.source,
      });
      return false;
    }

    const warnings = issues.filter(i => i.severity !== 'high');
    if (warnings.length > 0) {
      logger.info('[KnowledgeAgent] Entry ingested with warnings', {
        title: entry.title,
        warnings: warnings.map(i => i.description),
      });
    }

    const result = sharedIngest.ingestEntry(partial as any, options as any);
    scheduleVectorDbSync();
    logger.info('[KnowledgeAgent] Entry ingested', {
      id: result.id,
      title: entry.title,
      maturity: result.maturity,
      sourceRefs: result.sourceReferences?.length ?? 0,
    });
    return true;
  }

  private writeEntriesDirect(
    entries: Array<{ type: string; title: string; content: string; tags: string[] }>,
    taskId: string,
    projectId: string,
  ): void {
    for (const entry of entries) {
      this.safeIngest(
        {
          type: entry.type as any,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          projects: [projectId],
        },
        {
          source: `task:${taskId}`,
          layer: 'project',
          maturity: 'draft',
          tags: entry.tags,
          projects: [projectId],
        },
      );
    }
    logger.info('[KnowledgeAgent] Fallback direct write completed', { taskId, entryCount: entries.length });
  }

  private async getDiff(worktree: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git diff HEAD~1 2>/dev/null || git diff --cached 2>/dev/null || echo ""', {
        cwd: worktree,
        timeout: 10_000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getChangedFiles(worktree: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git diff --name-only HEAD~1 2>/dev/null || git diff --cached --name-only 2>/dev/null || echo ""', {
        cwd: worktree,
        timeout: 10_000,
      });
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── LLM-Powered Daily Maintenance (F1) ──────────────────

  /**
   * 每日知识维护入口（由 MonitorAgent daily cycle 调用）
   * 执行 4 个 LLM 驱动的质量操作：语义去重、内容质量评估、过期验证、矛盾审查
   */
  async runDailyMaintenance(): Promise<{
    dedupMerged: number;
    qualityArchived: number;
    freshnessUpdated: number;
    contradictionsResolved: number;
  }> {
    const startTime = Date.now();
    logger.info('[KnowledgeAgent] Daily maintenance started');

    const results = {
      dedupMerged: 0,
      qualityArchived: 0,
      freshnessUpdated: 0,
      contradictionsResolved: 0,
    };

    try {
      // 1. Semantic dedup
      results.dedupMerged = await this.semanticDedup();

      // 2. Content quality assessment
      results.qualityArchived = await this.assessQuality();

      // 3. Freshness validation (only if git repo available)
      results.freshnessUpdated = await this.validateFreshness();

      // 4. Contradiction resolution
      results.contradictionsResolved = await this.resolveContradictions();
    } catch (err) {
      logger.error('[KnowledgeAgent] Daily maintenance failed', { error: String(err) });
    }

    const durationMs = Date.now() - startTime;
    logger.info('[KnowledgeAgent] Daily maintenance completed', { ...results, durationMs });

    return results;
  }

  /**
   * F1a: 语义去重 — 用 LLM 判断内容相似的知识条目，合并重复
   *
   * 流程：取所有 active 条目 → 按 type 分组 → 每批 10 条送 LLM → 合并建议
   */
  private async semanticDedup(): Promise<number> {
    const entries = sharedStore.list({ excludeArchived: true });
    if (entries.length < 2) return 0;

    let merged = 0;
    // Group by type for more accurate comparison
    const byType = new Map<string, typeof entries>();
    for (const e of entries) {
      const group = byType.get(e.type) || [];
      group.push(e);
      byType.set(e.type, group);
    }

    for (const [type, typeEntries] of byType) {
      if (typeEntries.length < 2) continue;

      // Process in batches of 10
      for (let i = 0; i < typeEntries.length; i += 10) {
        const batch = typeEntries.slice(i, i + 10);
        if (batch.length < 2) continue;

        const entryList = batch.map((e, idx) =>
          `[${idx}] id=${e.id} title="${e.title}" content="${e.content.slice(0, 150)}..."`,
        ).join('\n');

        const prompt = `以下是一批同类型(type=${type})的知识条目。请判断哪些在语义上是重复的（描述同一个问题或决策），即使标题不同。

${entryList}

输出 JSON 格式：
{
  "duplicates": [
    { "keep": "保留的条目id", "merge": ["要合并的条目id"], "reason": "为什么是重复的" }
  ]
}

如果没有重复，返回 {"duplicates": []}。最多返回 5 组。`;

        try {
          const result = await modelGateway.promptJson<{ duplicates: Array<{ keep: string; merge: string[]; reason: string }> }>(
            prompt,
            '你是知识库去重专家。判断哪些知识条目在语义上是重复的。只合并真正重复的，不要合并相关但不同的条目。',
          );

          if (!result.duplicates?.length) continue;

          for (const dup of result.duplicates) {
            const keepEntry = sharedStore.get(dup.keep);
            if (!keepEntry) continue;

            for (const mergeId of dup.merge) {
              const mergeEntry = sharedStore.get(mergeId);
              if (!mergeEntry) continue;

              // Merge: archive the duplicate, keep the better one
              sharedStore.update(mergeId, { maturity: 'archived' });
              // Transfer sourceReferences from archived to kept entry
              const refs = [...(keepEntry.sourceReferences || []), ...(mergeEntry.sourceReferences || [])];
              const seen = new Set<string>();
              const deduped = refs.filter(r => {
                const key = `${r.workflow}:${r.timestamp}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              }).slice(-20);
              sharedStore.update(dup.keep, { sourceReferences: deduped });
              merged++;

              logger.info('[KnowledgeAgent] Semantic dedup merged', {
                keep: dup.keep,
                archived: mergeId,
                reason: dup.reason,
              });
            }
          }
        } catch (err) {
          logger.warn('[KnowledgeAgent] Semantic dedup batch failed', { type, error: String(err) });
        }
      }
    }

    return merged;
  }

  /**
   * F1b: 内容质量评估 — 用 LLM 评估每条知识是否值得保留
   *
   * 流程：取所有 active 条目 → 每批 10 条送 LLM → 低质量的 archive
   */
  private async assessQuality(): Promise<number> {
    const entries = sharedStore.list({ excludeArchived: true });
    if (entries.length === 0) return 0;

    let archived = 0;

    // Process in batches of 10
    for (let i = 0; i < entries.length; i += 10) {
      const batch = entries.slice(i, i + 10);

      const entryList = batch.map((e, idx) =>
        `[${idx}] id=${e.id} type=${e.type} title="${e.title}" content="${e.content.slice(0, 200)}"`,
      ).join('\n');

      const prompt = `请评估以下知识条目的质量。对每条判断是否值得保留。

评估标准：
1. 内容是否具体可操作（不是泛泛而谈）
2. 是否有根因分析（不只是描述现象）
3. 是否对未来的开发有参考价值
4. 是否是显而易见的事实（不需要记录）

${entryList}

输出 JSON 格式：
{
  "assessments": [
    { "id": "条目id", "keep": true/false, "reason": "保留/删除的理由", "score": 1-10 }
  ]
}

只标记 keep=false 的为低质量。`;

      try {
        const result = await modelGateway.promptJson<{ assessments: Array<{ id: string; keep: boolean; reason: string; score: number }> }>(
          prompt,
          '你是知识质量评估专家。严格评估每条知识的价值。只删除真正无价值的条目，有疑问的保留。',
        );

        if (!result.assessments?.length) continue;

        for (const assessment of result.assessments) {
          if (assessment.keep) continue;

          const entry = sharedStore.get(assessment.id);
          if (!entry || entry.maturity === 'proven') continue; // Don't archive proven entries

          sharedStore.update(assessment.id, { maturity: 'archived' });
          archived++;

          logger.info('[KnowledgeAgent] Quality assessment archived', {
            id: assessment.id,
            title: entry.title,
            reason: assessment.reason,
            score: assessment.score,
          });
        }
      } catch (err) {
        logger.warn('[KnowledgeAgent] Quality assessment batch failed', { error: String(err) });
      }
    }

    return archived;
  }

  /**
   * F1c: 过期验证 — 用 LLM 判断知识内容是否因代码变更而过期
   *
   * 流程：取最近 7 天有 git 变更的文件 → 匹配关联的知识条目 → LLM 判断是否过期
   */
  private async validateFreshness(): Promise<number> {
    let updated = 0;

    try {
      // Get recent git changes (last 7 days)
      const projectRoot = process.env.REPO_DIR || path.join(os.homedir(), 'projects');
      const { stdout: recentChanges } = await execAsync(
        'git log --since="7 days ago" --name-only --pretty=format: 2>/dev/null | sort -u | head -50',
        { cwd: projectRoot, timeout: 15_000 },
      );
      const changedFiles = recentChanges.trim().split('\n').filter(Boolean);
      if (changedFiles.length === 0) return 0;

      // Find entries that reference these files (by tags or content)
      const entries = sharedStore.list({ excludeArchived: true });
      const potentiallyStale = entries.filter(e => {
        const text = `${e.title} ${e.content} ${(e.tags || []).join(' ')}`.toLowerCase();
        return changedFiles.some(f => text.includes(f.toLowerCase()) || text.includes(path.basename(f, path.extname(f)).toLowerCase()));
      });

      if (potentiallyStale.length === 0) return 0;

      // Process in batches of 5
      for (let i = 0; i < potentiallyStale.length; i += 5) {
        const batch = potentiallyStale.slice(i, i + 5);

        const context = batch.map((e, idx) =>
          `[${idx}] id=${e.id} title="${e.title}" content="${e.content.slice(0, 200)}"`,
        ).join('\n');

        const prompt = `以下知识条目关联的代码文件在最近 7 天内有变更。请判断这些知识是否仍然正确。

最近变更的文件：
${changedFiles.slice(0, 20).join('\n')}

知识条目：
${context}

输出 JSON 格式：
{
  "results": [
    { "id": "条目id", "stillValid": true/false, "reason": "判断理由" }
  ]
}

如果知识描述的内容已被代码变更覆盖或修正，标记为 stillValid=false。`;

        try {
          const result = await modelGateway.promptJson<{ results: Array<{ id: string; stillValid: boolean; reason: string }> }>(
            prompt,
            '你是代码-知识一致性检查专家。判断知识条目描述的内容是否与最新代码一致。如果不确定，标记为 stillValid=true。',
          );

          if (!result.results?.length) continue;

          for (const r of result.results) {
            if (r.stillValid) continue;

            // Mark as draft for re-analysis
            sharedStore.update(r.id, { maturity: 'draft' });
            updated++;

            logger.info('[KnowledgeAgent] Freshness validation marked stale', {
              id: r.id,
              reason: r.reason,
            });
          }
        } catch (err) {
          logger.warn('[KnowledgeAgent] Freshness validation batch failed', { error: String(err) });
        }
      }
    } catch (err) {
      logger.warn('[KnowledgeAgent] Freshness validation failed', { error: String(err) });
    }

    return updated;
  }

  /**
   * F1d: 矛盾审查 — 用 LLM 检测同主题不同结论的知识条目
   *
   * 流程：按 tag 分组 → 同组内送 LLM → 检测矛盾 → 解决（保留更可靠的，标记另一个）
   */
  private async resolveContradictions(): Promise<number> {
    let resolved = 0;
    const entries = sharedStore.list({ excludeArchived: true });

    // Group by shared tags (at least 2 common tags)
    const tagGroups = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (!entry.tags || entry.tags.length === 0) continue;
      for (const tag of entry.tags) {
        const group = tagGroups.get(tag) || [];
        group.push(entry);
        tagGroups.set(tag, group);
      }
    }

    // Only check groups with 2+ entries
    for (const [tag, group] of tagGroups) {
      if (group.length < 2) continue;

      // Deduplicate by id within group
      const unique = [...new Map(group.map(e => [e.id, e])).values()];
      if (unique.length < 2) continue;

      const entryList = unique.map((e, idx) =>
        `[${idx}] id=${e.id} maturity=${e.maturity} title="${e.title}" content="${e.content.slice(0, 200)}"`,
      ).join('\n');

      const prompt = `以下知识条目都与标签 "${tag}" 相关。请检查它们之间是否存在矛盾（对同一问题给出相反的建议或结论）。

${entryList}

输出 JSON 格式：
{
  "contradictions": [
    {
      "entries": ["矛盾的条目id列表"],
      "description": "矛盾的具体描述",
      "resolution": "建议如何解决（保留哪个、修改哪个）"
    }
  ]
}

如果没有矛盾，返回 {"contradictions": []}。相关但不矛盾的条目不算。`;

      try {
        const result = await modelGateway.promptJson<{ contradictions: Array<{ entries: string[]; description: string; resolution: string }> }>(
          prompt,
          '你是知识一致性检查专家。只报告真正的矛盾（对同一问题给出相反建议），不要报告互补或不同角度的知识。',
        );

        if (!result.contradictions?.length) continue;

        for (const contradiction of result.contradictions) {
          // Keep the highest maturity entry, mark others as needing review
          const conflictEntries = contradiction.entries
            .map(id => sharedStore.get(id))
            .filter(Boolean) as typeof entries;

          if (conflictEntries.length < 2) continue;

          // Sort by maturity (proven > verified > draft)
          const maturityRank = { proven: 3, verified: 2, draft: 1, archived: 0 };
          conflictEntries.sort((a, b) => (maturityRank[b.maturity] || 0) - (maturityRank[a.maturity] || 0));

          // Mark lower-maturity entries as draft for re-analysis
          for (let j = 1; j < conflictEntries.length; j++) {
            sharedStore.update(conflictEntries[j].id, { maturity: 'draft' });
            resolved++;
          }

          logger.info('[KnowledgeAgent] Contradiction detected', {
            tag,
            entries: contradiction.entries,
            description: contradiction.description,
            resolution: contradiction.resolution,
          });
        }
      } catch (err) {
        logger.warn('[KnowledgeAgent] Contradiction check failed', { tag, error: String(err) });
      }
    }

    return resolved;
  }
}

export const knowledgeAgent = new KnowledgeAgent();
