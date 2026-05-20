"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentCompleter = exports.AgentCompleter = void 0;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs/promises"));
const studio_shared_1 = require("@dommaker/studio-shared");
const uuid_1 = require("uuid");
/**
 * Agent 完成处理器
 */
class AgentCompleter {
    worktreesDir;
    constructor(worktreesDir) {
        this.worktreesDir = worktreesDir || process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
    }
    /**
     * 处理任务完成
     */
    async complete(taskId) {
        const worktree = path.join(this.worktreesDir, taskId);
        studio_shared_1.logger.info('Processing task completion', { taskId });
        try {
            // Step 1: 检测输出文件
            const outputFiles = await this.detectOutputFiles(worktree);
            // Step 2: 解析验证结果
            const verifyResult = await this.parseVerificationResult(worktree);
            // Step 3: 更新任务状态
            const result = {
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
            }
            else {
                await this.publishEvent(taskId, 'agent.failed', {
                    failReason: result.failReason,
                    outputFiles: result.outputFiles,
                });
            }
            studio_shared_1.logger.info('Task completion processed', { taskId, result });
            return result;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            studio_shared_1.logger.error('Failed to process completion', { taskId, error: errorMessage });
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
    async detectOutputFiles(worktree) {
        const files = [];
        try {
            const entries = await fs.readdir(worktree, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile())
                    continue;
                // 跳过隐藏文件和日志文件
                if (entry.name.startsWith('.') || entry.name.endsWith('.log'))
                    continue;
                const filePath = path.join(worktree, entry.name);
                const stat = await fs.stat(filePath);
                const ext = path.extname(entry.name);
                let type = 'text';
                if (ext === '.md')
                    type = 'markdown';
                else if (ext === '.json')
                    type = 'json';
                files.push({
                    path: filePath,
                    name: entry.name,
                    type,
                    size: stat.size,
                });
            }
        }
        catch (error) {
            studio_shared_1.logger.debug('Failed to read output files', { worktree, error });
        }
        return files;
    }
    /**
     * 解析验证结果
     */
    async parseVerificationResult(worktree) {
        const verifyReportPath = path.join(worktree, 'verify-report.md');
        try {
            const content = await fs.readFile(verifyReportPath, 'utf-8');
            const passed = (content.match(/✅|通过/g) || []).length;
            const failed = (content.match(/❌|失败/g) || []).length;
            if (failed === 0 && passed > 0) {
                return { status: 'passed' };
            }
            else if (failed > 0 && passed > 0) {
                return {
                    status: 'partial',
                    failReason: `验证报告中有 ${failed} 项未通过`,
                };
            }
            else if (failed > 0) {
                return {
                    status: 'failed',
                    failReason: `验证失败: ${failed} 项未通过`,
                };
            }
            return { status: 'unknown' };
        }
        catch {
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
    async publishEvent(executionId, eventType, data) {
        const event = {
            event_id: (0, uuid_1.v4)(),
            event_type: eventType,
            timestamp: new Date().toISOString(),
            data: { executionId, ...data },
        };
        studio_shared_1.eventBus.publish('events', event);
    }
    /**
     * 清理 worktree
     */
    async cleanupWorktree(taskId, keepOutputs = true) {
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
            }
            else {
                // 完全清理
                await fs.rm(worktree, { recursive: true, force: true });
            }
        }
        catch (error) {
            studio_shared_1.logger.debug('Failed to cleanup worktree', { taskId, error });
        }
    }
}
exports.AgentCompleter = AgentCompleter;
// 单例实例
exports.agentCompleter = new AgentCompleter();
