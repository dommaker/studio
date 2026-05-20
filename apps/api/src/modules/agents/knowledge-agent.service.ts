/**
 * Knowledge Agent - 从执行结果中异步提取知识
 *
 * 被动模式：Executor 完成后自动触发，从 git diff + 测试结果中抽取知识。
 * 使用 harness KnowledgeStore + KnowledgeIngest 存储。
 */

import { modelGateway, logger } from '@dommaker/studio-shared';
import { KnowledgeStore, KnowledgeIngest } from '@dommaker/harness';
import { prisma } from '@dommaker/studio-prisma';
import { channelMessageService } from '../channels/channel-message.service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { KnowledgeExtraction } from './types.js';

const execAsync = promisify(exec);

const KNOWLEDGE_SYSTEM_PROMPT = `你是一个知识提取专家。请从以下代码变更和执行结果中提取有价值的知识条目。

每个知识条目应包含：
- type: "decision"（设计决策）| "pitfall"（踩坑记录）| "guideline"（最佳实践）| "model"（架构模式）
- title: 简洁标题
- content: 详细描述（2-3 句话）
- tags: 相关标签

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
- 如果没有值得提取的知识，返回空数组
- 最多提取 5 个条目`;

export class KnowledgeAgent {
  private store: KnowledgeStore;
  private ingest: KnowledgeIngest;

  constructor() {
    this.store = new KnowledgeStore();
    this.ingest = new KnowledgeIngest(this.store);
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
  private writeEntriesDirect(
    entries: Array<{ type: string; title: string; content: string; tags: string[] }>,
    taskId: string,
    projectId: string,
  ): void {
    for (const entry of entries) {
      this.ingest.ingestEntry(
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
}

export const knowledgeAgent = new KnowledgeAgent();
