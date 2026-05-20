/**
 * Agent Completer - TypeScript 实现的任务完成处理器
 * ============================================================================
 * 功能: 替代 complete-task.sh，在 TypeScript 中处理任务完成逻辑
 * 
 * 工作流程:
 *   1. 检测输出文件
 *   2. 解析验证结果
 *   3. 更新任务状态
 *   4. 发布完成事件
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { logger, eventBus } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';

// 完成结果
export interface CompletionResult {
  taskId: string;
  executionId: string;
  success: boolean;
  verifyStatus: 'passed' | 'partial' | 'failed' | 'no_output' | 'unknown';
  outputFiles: string[];
  failReason?: string;
  worktree: string;
}

// 输出文件信息
export interface OutputFile {
  path: string;
  name: string;
  type: 'markdown' | 'json' | 'text';
  size: number;
}

/**
 * Agent 完成处理器
 */
export class AgentCompleter {
  private worktreesDir: string;

  constructor(worktreesDir?: string) {
    this.worktreesDir = worktreesDir || process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
  }

  /**
   * 处理任务完成
   */
  async complete(taskId: string): Promise<CompletionResult> {
    const worktree = path.join(this.worktreesDir, taskId);
    
    logger.info('Processing task completion', { taskId });

    try {
      // Step 1: 检测输出文件
      const outputFiles = await this.detectOutputFiles(worktree);

      // Step 2: 解析验证结果
      const verifyResult = await this.parseVerificationResult(worktree);

      // Step 3: 更新任务状态
      const result: CompletionResult = {
        taskId,
        executionId: taskId,
        success: verifyResult.status !== 'failed' && verifyResult.status !== 'no_output',
        verifyStatus: verifyResult.status,
        outputFiles: outputFiles.map(f => f.path),
        failReason: verifyResult.failReason,
        worktree,
      };

      // Step 4: 发布完成事件
      if (result.success) {
        await this.publishEvent(taskId, 'agent.completed', {
          verifyStatus: result.verifyStatus,
          outputFiles: result.outputFiles,
        });
      } else {
        await this.publishEvent(taskId, 'agent.failed', {
          failReason: result.failReason,
          outputFiles: result.outputFiles,
        });
      }

      logger.info('Task completion processed', { taskId, result });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.error('Failed to process completion', { taskId, error: errorMessage });

      return {
        taskId,
        executionId: taskId,
        success: false,
        verifyStatus: 'unknown',
        outputFiles: [],
        failReason: errorMessage,
        worktree,
      };
    }
  }

  /**
   * 检测输出文件
   */
  async detectOutputFiles(worktree: string): Promise<OutputFile[]> {
    const files: OutputFile[] = [];

    try {
      const entries = await fs.readdir(worktree, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        
        // 跳过隐藏文件和日志文件
        if (entry.name.startsWith('.') || entry.name.endsWith('.log')) continue;

        const filePath = path.join(worktree, entry.name);
        const stat = await fs.stat(filePath);
        
        const ext = path.extname(entry.name);
        let type: OutputFile['type'] = 'text';
        if (ext === '.md') type = 'markdown';
        else if (ext === '.json') type = 'json';

        files.push({
          path: filePath,
          name: entry.name,
          type,
          size: stat.size,
        });
      }
    } catch (error) {
      logger.debug('Failed to read output files', { worktree, error });
    }

    return files;
  }

  /**
   * 解析验证结果
   */
  private async parseVerificationResult(worktree: string): Promise<{
    status: CompletionResult['verifyStatus'];
    failReason?: string;
  }> {
    const verifyReportPath = path.join(worktree, 'verify-report.md');

    try {
      const content = await fs.readFile(verifyReportPath, 'utf-8');
      
      const passed = (content.match(/✅|通过/g) || []).length;
      const failed = (content.match(/❌|失败/g) || []).length;

      if (failed === 0 && passed > 0) {
        return { status: 'passed' };
      } else if (failed > 0 && passed > 0) {
        return {
          status: 'partial',
          failReason: `验证报告中有 ${failed} 项未通过`,
        };
      } else if (failed > 0) {
        return {
          status: 'failed',
          failReason: `验证失败: ${failed} 项未通过`,
        };
      }

      return { status: 'unknown' };
    } catch {
      // 没有验证报告，检查是否有其他输出文件
      const outputs = await this.detectOutputFiles(worktree);
      
      if (outputs.length > 0) {
        return { status: 'passed' };
      }

      return {
        status: 'no_output',
        failReason: 'Agent 未输出任何文件',
      };
    }
  }

  /**
   * 发布事件
   */
  private async publishEvent(executionId: string, eventType: string, data: Record<string, any>): Promise<void> {
    const event = {
      event_id: uuidv4(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data: { executionId, ...data },
    };
    
    eventBus.publish('events', event);
  }

  /**
   * 清理 worktree
   */
  async cleanupWorktree(taskId: string, keepOutputs: boolean = true): Promise<void> {
    const worktree = path.join(this.worktreesDir, taskId);

    try {
      if (keepOutputs) {
        // 只清理临时文件，保留输出
        const entries = await fs.readdir(worktree);
        for (const entry of entries) {
          if (entry.startsWith('.') || entry.endsWith('.log')) {
            await fs.rm(path.join(worktree, entry), { force: true });
          }
        }
      } else {
        // 完全清理
        await fs.rm(worktree, { recursive: true, force: true });
      }
    } catch (error) {
      logger.debug('Failed to cleanup worktree', { taskId, error });
    }
  }
}

// 单例实例
export const agentCompleter = new AgentCompleter();
