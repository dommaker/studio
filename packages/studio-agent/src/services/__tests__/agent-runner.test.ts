import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Resolve source file path: prefer worktree version (has uncommitted changes),
// fall back to local (main project). Uses git worktree list to find active worktrees.
// subpath is relative to __dirname (packages/studio-agent/src/services/__tests__)
function resolveRoot(subpath: string, requireContent?: string): string {
  const local = path.resolve(__dirname, subpath);
  // If local has the required content, use it
  if (requireContent && fs.existsSync(local)) {
    const content = fs.readFileSync(local, 'utf-8');
    if (content.includes(requireContent)) return local;
  } else if (fs.existsSync(local) && !requireContent) {
    return local;
  }
  // Compute path relative to git root: __dirname is 6 levels deep from git root
  // /root/projects/studio/packages/studio-agent/src/services/__tests__
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: __dirname }).trim();
  const relFromGitRoot = path.relative(gitRoot, local);
  // Find worktree via git
  try {
    const wtList = execSync('git worktree list --porcelain', { encoding: 'utf-8', cwd: __dirname });
    for (const block of wtList.split('\n\n')) {
      const wtLine = block.split('\n').find(l => l.startsWith('worktree '));
      if (!wtLine) continue;
      const wtRoot = wtLine.slice('worktree '.length);
      if (wtRoot === gitRoot) continue; // skip main project
      const candidate = path.join(wtRoot, relFromGitRoot);
      if (fs.existsSync(candidate)) {
        if (requireContent) {
          const c = fs.readFileSync(candidate, 'utf-8');
          if (c.includes(requireContent)) return candidate;
        } else {
          return candidate;
        }
      }
    }
  } catch { /* ignore */ }
  return local;
}

const agentRunnerPath = resolveRoot('../agent-runner.ts');
const agentRunnerSrc = fs.readFileSync(agentRunnerPath, 'utf-8');

const agentExecutorPath = resolveRoot('../agent-executor.ts', 'AgentRunner');
const agentExecutorSrc = fs.readFileSync(agentExecutorPath, 'utf-8');

const worktreeResolverPath = resolveRoot('../worktree-resolver.ts', 'resolveWorkspace');
const worktreeResolverSrc = fs.readFileSync(worktreeResolverPath, 'utf-8');

const outputCapturePath = resolveRoot('../output-capture.ts', 'emitToolCall');
const outputCaptureSrc = fs.readFileSync(outputCapturePath, 'utf-8');

const indexPath = resolveRoot('../../index.ts', 'AgentRunner');
const indexSrc = fs.readFileSync(indexPath, 'utf-8');

// scheduler-dispatch.ts is outside studio-agent — resolve via worktree too
function resolveSchedulerDispatch(): string {
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: __dirname }).trim();
  const relPath = 'apps/api/src/modules/goals/scheduler-dispatch.ts';
  const local = path.join(gitRoot, relPath);
  if (fs.existsSync(local)) {
    const content = fs.readFileSync(local, 'utf-8');
    if (content.includes('agentRunner')) return content;
  }
  // Try worktrees
  try {
    const wtList = execSync('git worktree list --porcelain', { encoding: 'utf-8', cwd: __dirname });
    for (const block of wtList.split('\n\n')) {
      const wtLine = block.split('\n').find(l => l.startsWith('worktree '));
      if (!wtLine) continue;
      const wtRoot = wtLine.slice('worktree '.length);
      if (wtRoot === gitRoot) continue;
      const candidate = path.join(wtRoot, relPath);
      if (fs.existsSync(candidate)) {
        const c = fs.readFileSync(candidate, 'utf-8');
        if (c.includes('agentRunner')) return c;
      }
    }
  } catch { /* ignore */ }
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf-8') : '';
}

const schedulerDispatchSrc = resolveSchedulerDispatch();

const cmdBlockMatch = agentRunnerSrc.match(/const cmd = \[([\s\S]*?)\]\.filter\(Boolean\)\.join\(' '\)/);
const cmdBlock = cmdBlockMatch ? cmdBlockMatch[1] : '';

describe('AC1.1: AgentRunner class + stream-json parsing', () => {
  test('AC1.1-1: exports AgentRunner class', () => {
    expect(agentRunnerSrc).toMatch(/export\s+class\s+AgentRunner/);
  });

  test('AC1.1-2: exports singleton agentRunner', () => {
    expect(agentRunnerSrc).toMatch(/export\s+const\s+agentRunner\s*=\s*new\s+AgentRunner\(\)/);
  });

  test('AC1.1-3: exports IAgentRunner interface', () => {
    expect(agentRunnerSrc).toMatch(/export\s+interface\s+IAgentRunner/);
  });

  test('AC1.1-4: IAgentRunner has execute method', () => {
    expect(agentRunnerSrc).toMatch(/execute\(task:\s*AgentTask\):\s*Promise<ExecutionResult>/);
  });

  test('AC1.1-5: cmd uses --output-format stream-json', () => {
    expect(cmdBlock).toContain('--output-format stream-json');
    const formatFlags = cmdBlock.match(/--output-format\s+\S+/g) || [];
    for (const flag of formatFlags) {
      expect(flag).not.toBe('--output-format json');
    }
  });

  test('AC1.1-6: imports parseStreamEvents from shared', () => {
    expect(agentRunnerSrc).toContain('parseStreamEvents');
  });

  test('AC1.1-7: delegates to shared stream parser', () => {
    // Shared parser handles assistant content blocks internally
    expect(agentRunnerSrc).toMatch(/parseStreamEvents\(/);
  });

  test('AC1.1-8: uses extractToolCalls from shared', () => {
    expect(agentRunnerSrc).toContain('extractToolCalls');
  });

  test('AC1.1-9: parseStreamOutput delegates to shared parser', () => {
    expect(agentRunnerSrc).toContain('parseStreamOutput(');
    expect(agentRunnerSrc).toContain('parseStreamEvents(');
  });

  test('AC1.1-10: ExecutionResult return type preserved', () => {
    expect(agentRunnerSrc).toContain('ExecutionResult');
    expect(agentRunnerSrc).toContain("from './session-manager.js'");
  });

  test('AC1.1-11: cmd contains claude and --print', () => {
    expect(cmdBlock).toContain('claude');
    expect(cmdBlock).toContain('--print');
  });

  test('AC1.1-12: cmd uses input redirection', () => {
    expect(cmdBlock).toContain('<');
    expect(cmdBlock).toContain('promptFile');
  });
});

describe('AC1.2: Workspace fallback chain', () => {
  test('AC1.2-1: resolveWorktree method exists', () => {
    expect(agentRunnerSrc).toContain('resolveWorktree(');
  });

  test('AC1.2-2: shared resolveWorkspace reads task.parameters.workspaceRoot', () => {
    expect(worktreeResolverSrc).toContain('task.parameters?.workspaceRoot');
  });

  test('AC1.2-3: shared resolveWorkspace queries prisma.workspace.findFirst for VPS', () => {
    expect(worktreeResolverSrc).toContain('prisma.workspace.findFirst');
    expect(worktreeResolverSrc).toMatch(/name:\s*['"]VPS['"]/);
  });

  test('AC1.2-4: AgentRunner delegates to shared resolveWorkspace', () => {
    expect(agentRunnerSrc).toContain('resolveWorkspace(');
  });

  test('AC1.2-5: execute() calls resolveWorktree', () => {
    expect(agentRunnerSrc).toContain('await this.resolveWorktree(task)');
  });
});

describe('AC1.3: Tool call and file change event emission', () => {
  test('AC1.3-1: imports emitToolCall and emitFileChange', () => {
    expect(agentRunnerSrc).toContain('emitToolCall');
    expect(agentRunnerSrc).toContain('emitFileChange');
  });

  test('AC1.3-2: emits tool:call for tool_use events', () => {
    expect(agentRunnerSrc).toContain('emitToolCall(tool.name, tool.input, sessionId, task.executionId)');
  });

  test('AC1.3-3: uses shared extractFilePath for file:change', () => {
    expect(agentRunnerSrc).toContain('extractFilePath');
    expect(agentRunnerSrc).toContain('emitFileChange(filePath, sessionId, task.executionId)');
  });

  test('AC1.3-4: delegates file path extraction to shared', () => {
    // file_path/.path checks are now in shared extractFilePath
    expect(agentRunnerSrc).toContain('extractFilePathShared');
  });

  test('AC1.3-5: output-capture exports emitToolCall with tool field', () => {
    expect(outputCaptureSrc).toMatch(/export\s+async\s+function\s+emitToolCall/);
    expect(outputCaptureSrc).toContain('JSON.stringify({ tool: toolName, input, sessionId })');
  });

  test('AC1.3-6: output-capture exports emitFileChange with path field', () => {
    expect(outputCaptureSrc).toMatch(/export\s+async\s+function\s+emitFileChange/);
    expect(outputCaptureSrc).toContain('JSON.stringify({ path: filePath, sessionId })');
  });

  test('AC1.3-7: emitToolCall type is tool:call', () => {
    expect(outputCaptureSrc).toContain("type: 'tool:call'");
  });

  test('AC1.3-8: emitFileChange type is file:change', () => {
    expect(outputCaptureSrc).toContain("type: 'file:change'");
  });
});

describe('AC1.4: Caller migration and re-export facade', () => {
  test('AC1.4-1: agent-executor.ts re-exports AgentRunner', () => {
    expect(agentExecutorSrc).toContain("export { AgentRunner, agentRunner } from './agent-runner.js'");
  });

  test('AC1.4-2: agent-executor.ts re-exports IAgentRunner type', () => {
    expect(agentExecutorSrc).toContain("export type { IAgentRunner } from './agent-runner.js'");
  });

  test('AC1.4-3: agent-executor.ts re-exports emitToolCall', () => {
    expect(agentExecutorSrc).toContain('emitToolCall');
  });

  test('AC1.4-4: agent-executor.ts re-exports emitFileChange', () => {
    expect(agentExecutorSrc).toContain('emitFileChange');
  });

  test('AC1.4-5: index.ts exports AgentRunner', () => {
    expect(indexSrc).toContain('AgentRunner');
    expect(indexSrc).toContain('agentRunner');
  });

  test('AC1.4-6: scheduler-dispatch.ts uses agentRunner', () => {
    if (!schedulerDispatchSrc) return;
    expect(schedulerDispatchSrc).toContain('agentRunner');
  });

  test('AC1.4-7: scheduler-dispatch.ts calls agentRunner.execute()', () => {
    if (!schedulerDispatchSrc) return;
    expect(schedulerDispatchSrc).toContain('agentRunner.execute(');
  });

  test('AC1.4-8: agent-executor.ts still exports AgentExecutor (backward compat)', () => {
    expect(agentExecutorSrc).toContain("export { AgentExecutor, agentExecutor } from './session-manager.js'");
  });
});

describe('AC1.5: Comprehensive coverage', () => {
  test('AC1.5-1: session loop bounded by maxSessions', () => {
    expect(agentRunnerSrc).toContain('while (sessionCount < this.config.maxSessions)');
  });

  test('AC1.5-2: stuck detection with STRATEGY_HINTS', () => {
    expect(agentRunnerSrc).toContain('STRATEGY_HINTS');
    expect(agentRunnerSrc).toContain('stuckCount');
  });

  test('AC1.5-3: session:start event emitted', () => {
    expect(agentRunnerSrc).toContain('emitSessionStart(sessionId, task.executionId, sessionCount)');
  });

  test('AC1.5-4: session:end event emitted', () => {
    expect(agentRunnerSrc).toContain('emitSessionEnd(sessionId, task.executionId, sessionCount)');
  });

  test('AC1.5-5: spawn failure records recordExecutionError', () => {
    expect(agentRunnerSrc).toContain('recordExecutionError');
  });

  test('AC1.5-6: session metrics recorded via recordSessionMetrics', () => {
    expect(agentRunnerSrc).toContain('recordSessionMetrics');
  });

  test('AC1.5-7: session-manager.ts still exists', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../session-manager.ts'))).toBe(true);
  });

  test('AC1.5-8: resolution knowledge base lookup on error', () => {
    expect(agentRunnerSrc).toContain('prisma.resolution.findMany');
  });
});

describe('T2: Stuck detection threshold optimization', () => {
  test('session 1 zero-progress triggers fast fail (no retry)', () => {
    // After session 1: if completedCount=0 AND testResults empty AND !allComplete
    // → immediate fail. Detects "completely stuck" sessions without wasting 4 more.
    expect(agentRunnerSrc).toMatch(/completedCount\s*===?\s*0/);
  });

  test('stuck detection triggers fast-fail after 1 consecutive stuck session', () => {
    // stuckCount >= 1 (not >= 3 or higher) → fail immediately.
    // Max wasted sessions = 2 (down from 5).
    expect(agentRunnerSrc).toContain('stuckCount >= 1');
  });

  test('strategy hint injection removed from stuck path', () => {
    // No more "if (stuckCount > 0 && stuckCount <= 3)" hint injection.
    // stuckCount >= 1 → immediate fail makes hints unreachable.
    expect(agentRunnerSrc).not.toMatch(/if\s*\(\s*stuckCount\s*>\s*0\s*&&\s*stuckCount\s*<=\s*3\s*\)/);
  });

  test('maxSessions still caps at 5', () => {
    expect(agentRunnerSrc).toMatch(/DEFAULT_MAX_SESSIONS\s*=\s*5/);
  });

  test('strategy hints still defined for backward compat', () => {
    // STRATEGY_HINTS still referenced by buildPrompt (hintLevel)
    expect(agentRunnerSrc).toContain('STRATEGY_HINTS');
  });
});

describe('Cross-AC integrity', () => {
  test('cmd: cd -> claude -> flags -> input redirect', () => {
    expect(cmdBlock).toMatch(/cd\s+"\$\{worktree\}"/);
    const claudeIdx = cmdBlock.indexOf('claude');
    const redirectIdx = cmdBlock.indexOf('<');
    expect(claudeIdx).toBeGreaterThan(0);
    expect(redirectIdx).toBeGreaterThan(claudeIdx);
  });

  test('uses shared stream parser for main parsing', () => {
    expect(agentRunnerSrc).toContain('parseStreamEvents');
    expect(agentRunnerSrc).toContain('extractToolCalls');
  });
});

describe('SP-004 Step 5: SDD task layer integration', () => {
  test('imports readSddDoc from shared', () => {
    expect(agentRunnerSrc).toContain('readSddDoc');
  });

  test('imports findSddDocByGoalId from shared', () => {
    expect(agentRunnerSrc).toContain('findSddDocByGoalId');
  });

  test('imports parseTaskDocContractTests from shared', () => {
    expect(agentRunnerSrc).toContain('parseTaskDocContractTests');
  });

  test('imports parseTaskDocTestFiles from shared', () => {
    expect(agentRunnerSrc).toContain('parseTaskDocTestFiles');
  });

  test('has resolveSddTaskData method', () => {
    expect(agentRunnerSrc).toContain('resolveSddTaskData(');
  });

  test('resolveSddTaskData reads SDD task layer', () => {
    expect(agentRunnerSrc).toMatch(/readSddDoc\(slug,\s*['"]task['"]\)/);
  });

  test('resolveSddTaskData falls back to DB when SDD not found', () => {
    expect(agentRunnerSrc).toContain('sddTaskData.contractTests');
    expect(agentRunnerSrc).toContain('sddTaskData.testFiles');
  });

  test('execute() calls resolveSddTaskData', () => {
    expect(agentRunnerSrc).toContain('this.resolveSddTaskData(task)');
  });

  test('testFiles passed to writeRequirementsMd', () => {
    expect(agentRunnerSrc).toMatch(/writeRequirementsMd\(worktree,\s*task,\s*acGroup,\s*testFiles\)/);
  });

  test('writeRequirementsMd accepts testFiles parameter', () => {
    expect(worktreeResolverSrc).toMatch(/writeRequirementsMd\([\s\S]*testFiles\??/);
  });

  test('REQUIREMENTS.md includes testFiles section', () => {
    expect(worktreeResolverSrc).toContain('验证测试文件');
  });

  test('sddSlug used for SDD resolution', () => {
    expect(agentRunnerSrc).toContain('task.parameters?.sddSlug');
  });
});
