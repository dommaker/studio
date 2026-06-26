/**
 * Dogfood Status Dashboard — GET /api/v1/dogfood/status
 *
 * 返回当前 Goals、执行进度、系统健康的实时快照。
 * 用于 dogfood 开发时的 Pipeline 可见性。
 */
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router = Router();

interface ProgressSnapshot {
  taskId: string;
  allComplete: boolean;
  sessionCount: number;
  currentStep: string;
  completedSteps: string[];
  testResults: { passed: number; failed: number; total: number };
  lastCheckpoint: string;
  notes: string;
}

router.get('/status', async (_req, res) => {
  try {
    const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');

    // ── Active Goals ──
    const [executingGoals, draftGoals, pendingGoals] = await Promise.all([
      prisma.goal.findMany({
        where: { status: 'executing' },
        select: { id: true, title: true, status: true, context: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.goal.findMany({
        where: { status: 'draft' },
        select: { id: true, title: true, status: true, context: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.goal.findMany({
        where: { status: 'draft' },
        select: { id: true, title: true, status: true, context: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    // ── Running Executions (with progress from worktree) ──
    const runningExecs = await prisma.goalExecution.findMany({
      where: { status: 'running' },
      select: { id: true, goalId: true, stepIndex: true, agentType: true, input: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const executionsWithProgress = runningExecs.map(exec => {
      let progress: ProgressSnapshot | null = null;
      try {
        const wtPath = path.join(WORKTREES_DIR, exec.id);
        const progressFile = path.join(wtPath, '.progress.json');
        if (fs.existsSync(progressFile)) {
          progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
        }
      } catch { /* worktree may not exist yet */ }

      const input = exec.input ? JSON.parse(exec.input) : {};

      return {
        id: exec.id,
        goalId: exec.goalId,
        stepIndex: exec.stepIndex ?? 0,
        agentType: exec.agentType,
        createdAt: exec.createdAt,
        taskType: input.taskType || 'sub-agent',
        acCount: (input.acGroup as any)?.acs?.length || 0,
        files: (input.acGroup as any)?.files || [],
        progress,
      };
    });

    // ── Recently Completed ──
    const recentExecs = await prisma.goalExecution.findMany({
      where: { status: { in: ['succeeded', 'failed'] } },
      select: { id: true, goalId: true, status: true, error: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
      take: 20,
    });

    // ── Pipeline Runs (recent) ──
    const recentRuns = await prisma.pipelineRun.findMany({
      select: { id: true, phase: true, success: true, durationMs: true, inputTokens: true, outputTokens: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // ── System Health ──
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();
    const cpus = os.cpus().length;

    // Disk
    let diskInfo = { available: 'unknown', used: 'unknown' };
    try {
      const { execSync } = await import('child_process');
      const dfOut = execSync('df -h / | tail -1', { encoding: 'utf-8', timeout: 5000 }).trim();
      const parts = dfOut.split(/\s+/);
      if (parts.length >= 5) {
        diskInfo = { available: parts[3], used: parts[4] };
      }
    } catch { /* best-effort */ }

    // Worktree count
    let worktreeCount = 0;
    try {
      if (fs.existsSync(WORKTREES_DIR)) {
        worktreeCount = fs.readdirSync(WORKTREES_DIR).filter(f => {
          const stat = fs.statSync(path.join(WORKTREES_DIR, f));
          return stat.isDirectory();
        }).length;
      }
    } catch { /* best-effort */ }

    // ── Agent Context (buildAgentContext summary) ──
    let agentContextSummary: Record<string, unknown> = {};
    try {
      const { buildAgentContext } = await import('../agents/agent-context.js');
      agentContextSummary = buildAgentContext({ agentType: 'executor', compact: true }).summary as unknown as Record<string, unknown>;
    } catch { /* may not exist yet */ }

    // ── Response ──
    res.json({
      timestamp: new Date().toISOString(),
      goals: {
        executing: executingGoals.map(g => {
          const ctx = g.context ? JSON.parse(g.context) : {};
          return {
            id: g.id, title: g.title, status: g.status, createdAt: g.createdAt,
            sourceChannelId: ctx.sourceChannelId,
          };
        }),
        draft: draftGoals.map(g => ({ id: g.id, title: g.title, status: g.status, createdAt: g.createdAt })),
        pending: pendingGoals.map(g => ({ id: g.id, title: g.title, status: g.status, createdAt: g.createdAt })),
        total: executingGoals.length + draftGoals.length + pendingGoals.length,
      },
      executions: {
        running: executionsWithProgress,
        recent: recentExecs.map(e => ({
          id: e.id, goalId: e.goalId, status: e.status, completedAt: e.completedAt, error: e.error,
        })),
        totalRunning: runningExecs.length,
      },
      pipeline: {
        recentRuns: recentRuns.map(r => ({
          ...r,
          totalTokens: (r.inputTokens || 0) + (r.outputTokens || 0),
        })),
        successRate: recentRuns.length > 0
          ? Math.round((recentRuns.filter(r => r.success).length / recentRuns.length) * 100)
          : null,
      },
      system: {
        memory: {
          total: Math.round(totalMem / 1024 / 1024 / 1024),
          free: Math.round(freeMem / 1024 / 1024 / 1024),
          usedPercent: Math.round((1 - freeMem / totalMem) * 100),
        },
        cpu: { loadAvg: loadAvg.map(l => Math.round(l * 100) / 100), cores: cpus, loadPercent: Math.round((loadAvg[0] / cpus) * 100) },
        disk: diskInfo,
        worktrees: worktreeCount,
      },
      agentContext: agentContextSummary,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch dogfood status', detail: String(e) });
  }
});

export default router;
