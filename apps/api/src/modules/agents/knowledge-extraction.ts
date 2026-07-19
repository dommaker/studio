/**
 * Knowledge Agent — 提取子模块
 *
 * 从 knowledge-agent.service.ts 拆分（提取/冷启动/分析分离，零行为变更）。
 * 本模块负责从各类来源提取知识：
 *   - extract              执行结果（git diff + 变更文件 → LLM → #系统 确认卡片 / fallback 直写）
 *   - extractFromReview    P0a-1 审查结果
 *   - extractFromError     P0a-2 失败任务错误
 *   - extractFromCompletion P0a-3 执行完成输出
 *   - extractFromDeploy    P0a-4 部署结果
 *   - extractFromText      P0b 任意文本（通用 API）
 * 另含：提取 prompt 单一来源（EXTRACT_FROM_TEXT_SYSTEM_PROMPT + E1 文件覆盖 getter）、
 * #系统 Channel 获取/创建（extractUserBehavior 复用）、git diff/变更文件读取、fallback 直写。
 *
 * safeIngest（P2.5 质量门）保留在门面 knowledge-agent.service.ts，以 SafeIngestFn 参数注入。
 */

import { modelGateway, logger, readPromptOverride } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import { channelMessageService } from '../channels/channel-message.service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import type { KnowledgeExtraction } from './types.js';

const execAsync = promisify(exec);

/**
 * P2.5 validated-ingest 回调签名 — 与门面 safeIngest（及 KnowledgeIngest.ingestEntry）一致。
 * 拆分后 safeIngest 实现保留在门面（形态门禁见 knowledge-agent.service.ts），由此注入。
 */
export type SafeIngestFn = (
  partial: Partial<{ type: string; title: string; content: string; tags: string[]; projects: string[] }>,
  options: { source: string; layer: string; maturity?: string; tags?: string[]; projects?: string[] },
) => boolean;

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

/**
 * R3: 通用文本知识提取 prompt（extractFromText 与 KnowledgeService.extractFromConversation
 * 共用单一来源，避免两处漂移）。原 extractFromText 内的局部 EXTRACT_SYSTEM_PROMPT 提升而来。
 */
export const EXTRACT_FROM_TEXT_SYSTEM_PROMPT = `你是知识提取专家。从文本中提取结构化知识。对每条记录必须做三层分析：1) 根因（不描述表面现象），2) 责任归属（哪个 Agent/流程该预防），3) 预防措施（具体可操作）。\n\n关注类型：\n- 架构决策 (architecture) - 关于系统设计的讨论和决定\n- 设计决策 (decision) - 关于实现方式的取舍\n- 踩坑记录 (pitfall) - 遇到的问题，重点是根因而非现象\n- 流程经验 (process) - 流程中哪个环节该改进\n- 最佳实践 (guideline) - 可复用的经验和模式\n\n输出格式：{ "entries": [{ "type": "architecture|decision|pitfall|process|guideline", "title": "根因概括", "content": "根因+责任+预防", "tags": ["标签"] }] }\n只提取有价值的、可复用的知识。没有值得提取的知识则返回空数组。最多提取 5 个条目。`;

/**
 * E1 约束进化：提取 prompt 支持文件覆盖。
 * 覆盖文件 `~/.studio/prompt-overrides/knowledge.extract-from-text.md` 由进化提案
 * 批准后写入（不改写源码）；无覆盖时返回默认常量。两个调用点（本类 extractFromText
 * 与 KnowledgeService.extractFromConversation）都必须经此 getter。
 */
export function getExtractFromTextSystemPrompt(): string {
  return readPromptOverride('knowledge.extract-from-text') ?? EXTRACT_FROM_TEXT_SYSTEM_PROMPT;
}

/**
 * 从执行结果中提取知识（异步，不阻塞主流程）
 */
export async function extract(
  fileStore: FileStore,
  safeIngest: SafeIngestFn,
  params: {
    taskId: string;
    projectId: string;
    worktree: string;
    taskDescription: string;
    result: 'success' | 'failure';
    error?: string;
  },
): Promise<void> {
  const { taskId, projectId, worktree, taskDescription, result, error } = params;

  try {
    // 1. 读取 git diff
    const diff = await getDiff(worktree);

    // 2. 读取变更文件列表
    const changedFiles = await getChangedFiles(worktree);

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
    const sysChannel = await getOrCreateSystemChannel(fileStore);
    if (!sysChannel) {
      logger.warn('[KnowledgeAgent] #系统 channel not found, falling back to direct write', { taskId });
      writeEntriesDirect(safeIngest, extraction.entries, taskId, projectId);
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
export async function extractFromReview(
  fileStore: FileStore,
  safeIngest: SafeIngestFn,
  reviewResult: { approved: boolean; score: number; issues: Array<{ severity: string; message: string; file?: string; line?: number }>; suggestions: string[] },
  taskId: string,
  projectId: string,
): Promise<void> {
  try {
    // Part D: Resolve PMO number for knowledge tagging
    let pmoTag = '';
    try {
      const projData = await fileStore.readJson<{ pmoNumber: string }>(path.join(os.homedir(), '.studio', 'projects', `${projectId}.json`));
      if (projData?.pmoNumber) pmoTag = `pmo:${projData.pmoNumber}`;
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
      safeIngest(
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
export async function extractFromError(
  safeIngest: SafeIngestFn,
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
      safeIngest(
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
export async function extractFromCompletion(
  safeIngest: SafeIngestFn,
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
      safeIngest(
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
export async function extractFromDeploy(
  fileStore: FileStore,
  safeIngest: SafeIngestFn,
  deployResult: { success: boolean; type: string; findings: Array<{ severity: string; category: string; message: string }>; summary: string; artifact?: string },
  taskId: string,
  projectId: string,
): Promise<void> {
  try {
    // Part D: Resolve PMO number for knowledge tagging
    let pmoTag = '';
    try {
      const projData = await fileStore.readJson<{ pmoNumber: string }>(path.join(os.homedir(), '.studio', 'projects', `${projectId}.json`));
      if (projData?.pmoNumber) pmoTag = `pmo:${projData.pmoNumber}`;
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
      safeIngest(
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
export async function extractFromText(
  fileStore: FileStore,
  safeIngest: SafeIngestFn,
  content: string,
  source: string,
  layer: 'project' | 'system' | 'tech' | 'team' | 'domain' | 'personal' = 'system',
): Promise<void> {
  try {
    if (!content || content.trim().length === 0) {
      logger.info('[KnowledgeAgent] Empty text, skipping extraction', { source });
      return;
    }

    const truncatedContent = content.slice(0, 50_000);
    logger.info('[KnowledgeAgent] extractFromText starting', {
      source: source.slice(-40),
      contentLength: truncatedContent.length,
      originalLength: content.length,
    });

    let result: any;
    try {
      result = await modelGateway.promptJson(
        truncatedContent,
        getExtractFromTextSystemPrompt(),
        { provider: 'knowledge', tier: 'standard' },
      );
    } catch (e) {
      logger.warn('[KnowledgeAgent] Extraction failed', { source: source.slice(-40), error: String(e) });
      return;
    }

    if (!result.entries?.length) {
      logger.info('[KnowledgeAgent] No knowledge extracted from text', {
        source: source.slice(-40),
        parsedKeys: Object.keys(result),
      });
      return;
    }

    // Ingest entries
    for (const entry of result.entries) {
      safeIngest(
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
      const sysChannel = await getOrCreateSystemChannel(fileStore);
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
 * 获取或创建 #系统 Channel
 */
export async function getOrCreateSystemChannel(fileStore: FileStore): Promise<{ id: string; name: string } | null> {
  try {
    const channels = await fileStore.listChannels({ name: '#系统' });
    let channel = channels[0] ?? null;
    if (!channel) {
      const { randomUUID } = await import('crypto');
      const now = new Date().toISOString();
      await fileStore.createChannel({
        id: randomUUID(),
        name: '#系统',
        type: 'system',
        defaultWorkspaceId: null,
        defaultPath: null,
        discordChannelId: null,
        discordWebhookUrl: null,
        members: '[]',
        createdAt: now,
        updatedAt: now,
      });
      const newChannels = await fileStore.listChannels({ name: '#系统' });
      channel = newChannels[0] ?? null;
      if (channel) {
        logger.info('[KnowledgeAgent] Created #系统 channel', { channelId: channel.id });
      }
    }
    return channel ? { id: channel.id, name: channel.name } : null;
  } catch (err) {
    logger.error('[KnowledgeAgent] Failed to get/create #系统 channel', { error: String(err) });
    return null;
  }
}

/**
 * 直接写入知识库（fallback：当 #系统 Channel 不可用时）
 */
function writeEntriesDirect(
  safeIngest: SafeIngestFn,
  entries: Array<{ type: string; title: string; content: string; tags: string[] }>,
  taskId: string,
  projectId: string,
): void {
  for (const entry of entries) {
    safeIngest(
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

async function getDiff(worktree: string): Promise<string | null> {
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

async function getChangedFiles(worktree: string): Promise<string[]> {
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
