/**
 * Agent Executor - Session Loop 执行模型 (daemon async spawn)
 * ============================================================================
 *
 * 2026-05-09: Docker+tmux+Redis → async spawn (复用 SessionManager 的 execAsync 模式)
 *   - 每个 GoalExecution 独立 worktree → 天然支持并行
 *   - Session 1: --session-id <UUID> --name <name>  创建命名 session
 *   - Session 2+: --continue  复用 prompt cache
 *   - 读 .progress.json 判断完成，不信任 exit code
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { logger, getModelForTier } from '@dommaker/studio-shared';
import { beforeAgentExecute, buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';
import { skillLoader, type SkillTier } from '@dommaker/studio-skill';

// 配置类型
export interface ExecutorConfig {
  worktreesDir: string;
  repoDir: string;
  taskTimeoutMinutes: number;
  sessionTimeoutMinutes: number;
  maxSessions: number;
}

// 任务类型
export interface AgentTask {
  id: string;
  executionId: string;
  agentType: 'codex' | 'claude';
  model?: string;
  prompt: string;
  notifyTarget?: string;
  parameters?: Record<string, any>;
}

// 执行结果
export interface ExecutionResult {
  success: boolean;
  worktree: string;
  outputFiles: string[];
  error?: string;
  logFile: string;
  sessionCount: number;
  /** 累计指标（所有 session 之和） */
  totalTokens?: { input: number; output: number; cacheHit: number };
  totalDurationMs?: number;
  model?: string;
}

// 前置检查结果
export interface PrerequisiteCheck {
  name: string;
  passed: boolean;
  message: string;
  isWarning?: boolean;
}

// .progress.json 结构
interface ProgressReport {
  taskId: string;
  allComplete: boolean;
  sessionCount: number;
  currentStep: string;
  completedSteps: string[];
  testResults: { passed: number; failed: number; total: number };
  lastCheckpoint: string;
  notes: string;
}

const DEFAULT_SESSION_TIMEOUT = 30; // 分钟
const DEFAULT_MAX_SESSIONS = 5;

/** Async spawn: run shell command, collect stdout/stderr, with timeout */
function execAsync(
  cmd: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number; childRef?: { current: ChildProcess | null } },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Store child reference for external stop()
    if (opts.childRef) {
      opts.childRef.current = child;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (opts.maxBuffer && stdout.length > opts.maxBuffer) {
        child.kill();
        if (opts.childRef) opts.childRef.current = null;
        reject(new Error(`stdout maxBuffer (${opts.maxBuffer / 1024 / 1024}MB) exceeded`));
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      if (opts.childRef) opts.childRef.current = null;
      reject(new Error(`Task timed out after ${Math.round(opts.timeoutMs / 60000)}min`));
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (opts.childRef) opts.childRef.current = null;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Command exited with code ${code}: ${stderr.slice(0, 200)}`) as any;
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (opts.childRef) opts.childRef.current = null;
      reject(err);
    });
  });
}

/** 策略切换指令 — 逐级升级 */
const STRATEGY_HINTS: Record<number, string> = {
  0: '',
  1: `⚠️ 上次 session 停在同一个步骤无进展。不要重复相同的尝试。换一种实现思路，先解释你打算尝试的新方法（2-3 句），再动手。`,
  2: `⚠️⚠️ 已经连续 2 次卡在同一处。缩小范围：只做当前步骤最核心的部分，跳过边缘情况。写完最小实现后立即跑测试验证。`,
  3: `⚠️⚠️⚠️ 严重阻塞 — 连续 3 次无进展。强制切换模式：1) 先不要写代码，读 REQUIREMENTS.md 和现有代码；2) 写出 3 步以内的 mini plan；3) 只实现第 1 步，跑测试；4) 跑通后再继续`,
  4: `🔴 最后一次机会 — 放弃当前方向，从第 0 行重新开始，用最简单、最朴素的方式实现（哪怕代码丑），先让测试通过。`,
};

/**
 * Agent 执行器（session loop + async spawn）
 */
export class AgentExecutor {
  private config: ExecutorConfig;
  private runningProcesses = new Map<string, { current: ChildProcess | null }>();

  constructor(config?: Partial<ExecutorConfig>) {
    const homeDir = os.homedir();

    this.config = {
      worktreesDir: config?.worktreesDir || process.env.WORKTREES_DIR || path.join(homeDir, 'worktrees'),
      repoDir: config?.repoDir || process.env.REPO_DIR || (() => {
        // 默认回退：向上找 package.json
        let dir = process.cwd();
        while (dir !== '/' && !fsSync.existsSync(path.join(dir, 'package.json'))) {
          dir = path.dirname(dir);
        }
        return fsSync.existsSync(path.join(dir, 'package.json')) ? dir : path.join(homeDir, 'projects');
      })(),
      taskTimeoutMinutes: config?.taskTimeoutMinutes || 60,
      sessionTimeoutMinutes: config?.sessionTimeoutMinutes || DEFAULT_SESSION_TIMEOUT,
      maxSessions: config?.maxSessions || DEFAULT_MAX_SESSIONS,
      ...config,
    };
  }

  /**
   * 执行任务（session loop 模型）
   *
   * 不信任 Claude Code exit code，改读 .progress.json 判断完成。
   * 静默退出 / 超时 / 崩溃 → 自动 re-spawn。
   */
  async execute(task: AgentTask): Promise<ExecutionResult> {
    const worktree = path.join(this.config.worktreesDir, task.executionId);
    const logFile = path.join(worktree, '.agent.log');

    logger.info('[AgentExecutor] Starting session loop', { taskId: task.id, executionId: task.executionId });

    try {
      // Step 1: 前置检查
      const checks = await this.checkPrerequisites();
      const errors = checks.filter(c => !c.passed && !c.isWarning);
      if (errors.length > 0) {
        throw new Error(`前置检查失败: ${errors.map(e => e.message).join(', ')}`);
      }

      // Step 2: 创建 worktree（git worktree add）
      // 优先使用任务指定的 project repo，否则回退到 agent-studio 自身仓库
      const projectRepo = (task.parameters?.repoDir as string) || this.config.repoDir;
      const baseBranch = (task.parameters?.baseBranch as string) || 'main';
      await this.createWorktree(worktree, baseBranch, projectRepo);

      // Step 2.1: 传播 harness 约束（从 agent-studio 的 .harness/ 模板复制，确保版本一致）
      try {
        const harnessDir = path.join(worktree, '.harness');
        if (!fsSync.existsSync(harnessDir)) {
          // 从 agent-studio 自身的 .harness/ 目录复制配置模板
          const templateDir = path.resolve(process.cwd(), '.harness');
          if (fsSync.existsSync(templateDir)) {
            fsSync.mkdirSync(harnessDir, { recursive: true });
            for (const f of ['config.yml', 'checkpoints.yml', 'custom-constraints.yml']) {
              const src = path.join(templateDir, f);
              if (fsSync.existsSync(src)) {
                fsSync.copyFileSync(src, path.join(harnessDir, f));
              }
            }
          } else {
            // fallback: 从 harness 包的 templates 目录复制
            const harnessPkgDir = path.dirname(require.resolve('@dommaker/harness/package.json'));
            const nodeApiTpl = path.join(harnessPkgDir, 'templates', 'node-api');
            if (fsSync.existsSync(nodeApiTpl)) {
              await execAsync(`cp -r "${nodeApiTpl}/.harness" "${harnessDir}" 2>/dev/null || true`, {
                cwd: worktree, timeoutMs: 5000,
              });
            }
          }
        }
      } catch { /* harness init is best-effort — don't block execution */ }

      // Step 2.5: 前置硬约束检查 (Iron Laws)
      await beforeAgentExecute({
        operation: 'code_implementation',
        hasWorktree: true,
        worktreePath: worktree,
        taskDescription: task.prompt,
        hasVerificationEvidence: true,
        hasRequirement: true,
        hasSingleTask: true,
        hasRequirementReview: true,
        hasExternalCapabilityVerification: true,
        hasTest: true,
        hasTwoStageReview: true,              // code_implementation triggers review gate
        hasRootCauseInvestigation: true,      // guideline — error analysis
        hasFailingTest: true,                // TDD requires failing test first
      });

      // Step 2.6: 写入 REQUIREMENTS.md（文件桥，session 间不重复传）
      const acGroup = task.parameters?.acGroup as Record<string, any> | undefined;
      await this.writeRequirementsMd(worktree, task, acGroup);

      // Step 3: Session loop（含卡住检测 + 策略切换）
      const startTime = Date.now();
      let sessionCount = 0;
      let stuckCount = 0;
      let lastStep = '';
      let lastCompletedCount = 0;
      // 累计指标（定义在 try 外，catch/finally 可访问）
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheHitTokens = 0;

      // Session-id 文件（复用 SessionManager 的 UUID 持久化模式）
      const sidFile = path.join(worktree, '.daemon', 'session-id');
      fsSync.mkdirSync(path.dirname(sidFile), { recursive: true });
      let sessionId: string;
      let isNewSession: boolean;
      if (fsSync.existsSync(sidFile)) {
        const raw = fsSync.readFileSync(sidFile, 'utf-8').trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
          sessionId = raw;
          isNewSession = false;
        } else {
          sessionId = uuidv4();
          fsSync.writeFileSync(sidFile, sessionId, 'utf-8');
          isNewSession = true;
        }
      } else {
        sessionId = uuidv4();
        fsSync.writeFileSync(sidFile, sessionId, 'utf-8');
        isNewSession = true;
      }

      while (sessionCount < this.config.maxSessions) {
        sessionCount++;

        // 确保文件桥存在（可能被上轮 session 删除）
        const reqPath = path.join(worktree, 'REQUIREMENTS.md');
        if (!fsSync.existsSync(reqPath)) {
          fsSync.mkdirSync(worktree, { recursive: true });
          logger.warn('[AgentExecutor] REQUIREMENTS.md missing, re-writing', { taskId: task.id, executionId: task.executionId, session: sessionCount });
          await this.writeRequirementsMd(worktree, task, acGroup);
        }

        // 读进度（session 2+ 用于续接 prompt）
        const progress = this.readProgress(worktree);

        // 卡住检测：连续 session 无进展
        const currentStep = progress?.currentStep || '';
        const completedCount = progress?.completedSteps?.length || 0;

        if (sessionCount > 1) {
          if (currentStep === lastStep && completedCount <= lastCompletedCount) {
            stuckCount++;
            logger.warn('[AgentExecutor] Stuck detected', { taskId: task.id, executionId: task.executionId, session: sessionCount, stuckCount, currentStep, completedCount });
          } else {
            stuckCount = Math.max(0, stuckCount - 1);
          }
        }
        lastStep = currentStep;
        lastCompletedCount = completedCount;

        // 构建 prompt（卡住时注入策略切换）
        const knowledgeContext = (task.parameters?.knowledgeContext as string) || '';
        const prompt = this.buildPrompt(task, progress, sessionCount, acGroup, stuckCount, knowledgeContext);
        fsSync.mkdirSync(worktree, { recursive: true });
        await fs.writeFile(path.join(worktree, '.prompt.md'), prompt, 'utf-8');

        // 启动 Agent（async spawn）
        const isFirstSession = sessionCount === 1;
        const sessionFlag = isFirstSession
          ? (isNewSession
              ? `--session-id ${sessionId} --name "executor-${task.executionId.slice(0, 8)}"`
              : '--continue')
          : '--continue';

        const model = getModelForTier((task.model as 'fast' | 'standard' | 'premium') || 'standard');

        // Write prompt to file, pipe via stdin (same pattern as SessionManager)
        const promptFile = path.join(worktree, '.daemon', 'prompt.md');
        fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
        fsSync.writeFileSync(promptFile, prompt, 'utf-8');

        const cmd = [
          `cd "${worktree}"`,
          `&&`,
          `cat '${promptFile}'`,
          `|`,
          `claude`,
          `--print`,
          `--output-format json`,
          `--dangerously-skip-permissions`,
          sessionFlag,
          `2>&1 | tee -a "${logFile}"`,
        ].join(' ');

        logger.info('[AgentExecutor] Spawning session', {
          taskId: task.id,
          executionId: task.executionId,
          session: sessionCount,
          isFirstSession,
          isNewSession,
          model,
        });

        // Track child process for external stop()
        const childRef: { current: ChildProcess | null } = { current: null };
        this.runningProcesses.set(task.executionId, childRef);

        try {
          const { stdout } = await execAsync(cmd, {
            cwd: worktree,
            env: {
              ANTHROPIC_MODEL: model,
              STUDIO_EXECUTION_ID: task.executionId,
              ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
            },
            timeoutMs: this.config.sessionTimeoutMinutes * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
            childRef,
          });

          // Parse JSON envelope + extract usage
          let text = stdout;
          let isError = false;
          try {
            const envelope = JSON.parse(stdout);
            if (envelope.is_error) { isError = true; text = ''; }
            if (envelope.result) text = envelope.result;
            // Extract token usage
            if (envelope.usage) {
              totalInputTokens += envelope.usage.input_tokens || 0;
              totalOutputTokens += envelope.usage.output_tokens || 0;
              totalCacheHitTokens += envelope.usage.cache_read_input_tokens || 0;
            }
          } catch (e) {
            logger.error('[AgentExecutor] Failed to parse JSON envelope', { taskId: task.id, executionId: task.executionId, error: String(e) });
          }

          if (isError) {
            logger.warn('[AgentExecutor] Claude Code returned error', { taskId: task.id, executionId: task.executionId, session: sessionCount, text: text.slice(0, 200) });
          }
        } catch (execErr: any) {
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          const stderrText = execErr?.stderr?.toString() || '';

          logger.warn('[AgentExecutor] Session failed', {
            taskId: task.id, executionId: task.executionId,
            session: sessionCount,
            error: errMsg.slice(0, 200),
          });

          if (sessionCount >= this.config.maxSessions) {
            return this.buildResult(false, worktree, [], logFile, sessionCount,
              `Max sessions (${this.config.maxSessions}) exhausted. Last error: ${errMsg.slice(0, 200)}`,
              totalInputTokens, totalOutputTokens, totalCacheHitTokens, startTime, model);
          }
          }
          // 未达上限 → 继续下一轮
          continue;
        }

        // After first successful session, future starts use --continue
        isNewSession = false;

        // 判断是否真的完成了
        const latest = this.readProgress(worktree);

        if (latest?.allComplete && (latest.testResults?.failed === 0 || latest.testResults?.failed == null)) {
          const outputFiles = await this.collectOutputFiles(worktree);
          logger.info('[AgentExecutor] Task completed', { taskId: task.id, executionId: task.executionId, sessionCount });
          return this.buildResult(true, worktree, outputFiles, logFile, sessionCount,
            undefined, totalInputTokens, totalOutputTokens, totalCacheHitTokens, startTime, model);
        }

        // 5 次耗尽
        if (sessionCount >= this.config.maxSessions) {
          return this.buildResult(false, worktree, [], logFile, sessionCount,
            `Max sessions (${this.config.maxSessions}) exhausted without completion`,
            totalInputTokens, totalOutputTokens, totalCacheHitTokens, startTime, model);
        }

        // 未完成 → 继续下一轮
        logger.info('[AgentExecutor] Session incomplete, re-spawning', {
          taskId: task.id, executionId: task.executionId,
          session: sessionCount,
          stuckCount,
          currentStep: latest?.currentStep || 'unknown',
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.buildResult(false, worktree, [], logFile, 0, errorMessage,
        totalInputTokens || 0, totalOutputTokens || 0, totalCacheHitTokens || 0, startTime || Date.now(), '');
    } finally {
      this.runningProcesses.delete(task.executionId);
    }

    return this.buildResult(false, worktree, [], logFile, 0, 'Unreachable', 0, 0, 0, Date.now(), '');
  }

  // ========================================
  // 前置检查
  // ========================================

  async checkPrerequisites(): Promise<PrerequisiteCheck[]> {
    const checks: PrerequisiteCheck[] = [];
    logger.info('[AgentExecutor] Checking prerequisites', { repoDir: this.config.repoDir });

    // Claude Code CLI
    try {
      const { stdout } = await execAsync('claude --version 2>&1 || echo "NOT_FOUND"', {
        cwd: '/tmp',
        timeoutMs: 10_000,
      });
      if (stdout.includes('NOT_FOUND')) {
        checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude 命令不可用' });
      } else {
        checks.push({ name: 'Claude Code CLI', passed: true, message: stdout.trim().slice(0, 80) });
      }
    } catch {
      checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude 命令不可用' });
    }

    // 磁盘空间
    try {
      const { stdout } = await execAsync('df -h . | tail -1 | awk "{print \$4}"', {
        cwd: this.config.worktreesDir,
        timeoutMs: 5_000,
      });
      const cleaned = stdout.trim().replace(/[^0-9.]/g, '');
      const availableGB = parseInt(cleaned, 10);
      if (isNaN(availableGB)) {
        checks.push({ name: '磁盘空间', passed: true, message: `无法解析: "${stdout.trim()}"`, isWarning: true });
      } else {
        checks.push({
          name: '磁盘空间', passed: availableGB >= 5,
          message: `磁盘空间: ${availableGB}GB`,
          isWarning: availableGB < 5 && availableGB >= 2,
        });
      }
    } catch {
      checks.push({ name: '磁盘空间', passed: true, message: '无法检测', isWarning: true });
    }

    // worktrees 目录
    try {
      await fs.mkdir(this.config.worktreesDir, { recursive: true });
      checks.push({ name: 'worktrees 目录', passed: true, message: `目录可写: ${this.config.worktreesDir}` });
    } catch {
      checks.push({ name: 'worktrees 目录', passed: false, message: `目录不可写: ${this.config.worktreesDir}` });
    }

    // git repo
    try {
      await execAsync('git rev-parse --git-dir', {
        cwd: this.config.repoDir,
        timeoutMs: 5_000,
      });
      checks.push({ name: 'Git Repo', passed: true, message: `主仓库: ${this.config.repoDir}` });
    } catch {
      checks.push({ name: 'Git Repo', passed: false, message: `${this.config.repoDir} 不是 git 仓库` });
    }

    return checks;
  }

  // ========================================
  // Worktree
  // ========================================

  /**
   * 创建 worktree（真 git worktree add）
   */
  private async createWorktree(worktree: string, baseBranch: string, repoDir: string): Promise<void> {
    // 清理已存在的目录
    try {
      await execAsync(`git worktree remove --force "${worktree}" 2>/dev/null || true`, {
        cwd: repoDir,
        timeoutMs: 10_000,
      });
    } catch (e) {
      logger.warn('[AgentExecutor] Failed to remove worktree, continuing', { error: String(e) });
    }

    try {
      await fs.rm(worktree, { recursive: true, force: true });
    } catch (e) {
      logger.warn('[AgentExecutor] Failed to clean worktree dir, continuing', { error: String(e) });
    }

    // 创建 git worktree
    const branchName = `task/${path.basename(worktree)}`.substring(0, 50);
    await execAsync(
      `git worktree add -b "${branchName}" "${worktree}" "${baseBranch}"`,
      { cwd: repoDir, timeoutMs: 30_000 },
    );

    logger.info('[AgentExecutor] Git worktree created', { worktree, branch: branchName, base: baseBranch, repo: repoDir });
  }

  // ========================================
  // 文件桥：REQUIREMENTS.md + .progress.json
  // ========================================

  /**
   * 写入 REQUIREMENTS.md（session 间共享的 AC 上下文）
   */
  private async writeRequirementsMd(
    worktree: string,
    task: AgentTask,
    acGroup?: Record<string, any>,
  ): Promise<void> {
    const acs: string[] = acGroup?.acs || [];
    const files: string[] = acGroup?.files || [];
    const notes: string = acGroup?.implementationNotes || '';
    const patterns: string[] = acGroup?.codePatterns || [];
    const gotchas: string[] = acGroup?.gotchas || [];

    const sections = [
      '# 需求',
      `## 任务`,
      task.prompt,
      '',
      '## 你负责的验收标准',
      ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : ['（从任务描述中推断）']),
      '',
      ...(notes ? ['## 实现指南', notes, ''] : []),
      ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
      ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
      ...(files.length > 0 ? ['## 预期改动文件', ...files.map(f => `- ${f}`), ''] : []),
      '## 行为约束',
      '- 完成前必须运行 npm test + type check + lint',
      '- 禁止模糊声明完成',
      '- 每完成一个步骤后立即更新 .progress.json',
      '- 全部 AC 测试通过后才设置 .progress.json allComplete: true',
    ];

    await fs.writeFile(path.join(worktree, 'REQUIREMENTS.md'), sections.join('\n'), 'utf-8');
  }

  /**
   * 读取 .progress.json
   */
  private readProgress(worktree: string): ProgressReport | null {
    try {
      const raw = fsSync.readFileSync(path.join(worktree, '.progress.json'), 'utf-8');
      return JSON.parse(raw) as ProgressReport;
    } catch {
      return null;
    }
  }

  /**
   * 构建 Agent prompt
   *
   * Session 1: 简要指令 + 读 REQUIREMENTS.md
   * Session 2+: 极短续接（文件桥，上下文靠 worktree 文件）
   * 卡住时注入策略切换指令
   */
  private buildPrompt(
    task: AgentTask,
    progress: ProgressReport | null,
    session: number,
    acGroup?: Record<string, any>,
    stuckCount = 0,
    knowledgeContext?: string,
  ): string {
    // 约束注入
    const constraintPrompt = buildAgentConstraintPrompt({
      operation: 'code_implementation',
      taskDescription: task.prompt,
    });

    const rawConstraints = task.parameters?.roleConstraints;
    const roleConstraints: string[] = Array.isArray(rawConstraints) ? rawConstraints
      : typeof rawConstraints === 'string' ? JSON.parse(rawConstraints)
      : [];
    const roleConstraintSection = roleConstraints.length
      ? `\n## 角色约束\n以下约束优先于一般指导原则：\n${roleConstraints.map((c: string) => `- ${c}`).join('\n')}\n`
      : '';

    // G-001~003: 知识上下文（偏好 + 规则 + 环境 + 历史决策）
    const knowledgeSection = knowledgeContext
      ? `\n## 项目上下文\n${knowledgeContext}\n`
      : '';

    const constraintSection = constraintPrompt || roleConstraintSection || knowledgeSection
      ? (constraintPrompt + roleConstraintSection + knowledgeSection + '\n---\n\n')
      : '';

    // Skill 注入：按 trigger + agentType 加载
    const skillTier = (task.model as SkillTier) || 'standard';
    const skills = session === 1
      ? skillLoader.load({ trigger: 'goal_start', agentType: 'executor', tier: skillTier })
      : skillLoader.load({ trigger: 'goal_continue', agentType: 'executor', tier: skillTier, exclude: ['stuck-recovery'] });
    const skillPrompt = skillLoader.formatForPrompt(skills);

    if (session === 1 || !progress) {
      return `${constraintSection}## 你的任务
${task.prompt}

${skillPrompt}

## TDD 工作流

严格按以下流程工作：

1. 读 AC → 写失败的测试
2. 运行测试确认失败
3. 最小实现让测试通过 → 运行确认通过
4. 重构优化
5. 重复 1-4 直到所有 AC 满足
6. 运行 npm test + type check + lint
7. 更新 .progress.json
8. 全部 AC 覆盖 + 全部测试通过 → 设置 .progress.json allComplete: true`;
    }

    // Session 2+: 极短续接 prompt
    const hintLevel = Math.min(stuckCount, 4);
    const strategyHint = STRATEGY_HINTS[hintLevel];
    const parts = [
      `${constraintSection}## 续接任务`,
      '',
      '读 REQUIREMENTS.md 了解任务。',
      '读 .progress.json 了解进度。',
      '',
      `你上次做到：${progress.currentStep || '未知'}`,
      `已完成：${progress.completedSteps?.join(', ') || '无'}`,
      `测试结果：${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed`,
      `备注：${progress.notes || '无'}`,
    ];
    if (skillPrompt) parts.push('', skillPrompt);
    if (strategyHint) parts.push('', strategyHint);
    parts.push('', '继续工作，从上次中断的地方开始。每完成一步后更新 .progress.json。');
    parts.push('全部完成后设置 allComplete: true。');
    return parts.join('\n');
  }

  // ========================================
  // 辅助方法
  // ========================================

  private async collectOutputFiles(worktree: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.readdir(worktree);
      for (const entry of entries) {
        if (entry.endsWith('.md') || entry.endsWith('.json')) {
          files.push(path.join(worktree, entry));
        }
      }
    } catch (e) {
      logger.warn('[AgentExecutor] Failed to collect output files', { error: String(e) });
    }
    return files;
  }

  /**
   * Stop a running execution by killing its child process.
   * Uses the runningProcesses Map to find and SIGTERM the child.
   */
  async stop(executionId: string): Promise<void> {
    // Try exact match first, then prefix match
    let childRef = this.runningProcesses.get(executionId);
    if (!childRef) {
      for (const [key, value] of this.runningProcesses.entries()) {
        if (key.startsWith(executionId)) {
          childRef = value;
          executionId = key;
          break;
        }
      }
    }

    if (childRef?.current) {
      logger.info('[AgentExecutor] Stopping child process', { executionId });
      childRef.current.kill('SIGTERM');
      this.runningProcesses.delete(executionId);

      // Force kill after 5s if still alive
      setTimeout(() => {
        if (childRef?.current) {
          try { childRef.current.kill('SIGKILL'); } catch {}
        }
      }, 5000);
    } else {
      logger.info('[AgentExecutor] Stop requested but no child process found', { executionId });
    }
  }

  private buildResult(
    success: boolean, worktree: string, outputFiles: string[], logFile: string,
    sessionCount: number, error: string | undefined,
    inputTokens: number, outputTokens: number, cacheHitTokens: number,
    startTime: number, model: string,
  ): ExecutionResult {
    return {
      success, worktree, outputFiles, logFile, sessionCount,
      ...(error ? { error } : {}),
      totalTokens: { input: inputTokens, output: outputTokens, cacheHit: cacheHitTokens },
      totalDurationMs: Date.now() - startTime,
      ...(model ? { model } : {}),
    };
  }

  getStatus(): { config: ExecutorConfig } {
    return { config: this.config };
  }
}

export const agentExecutor = new AgentExecutor();
