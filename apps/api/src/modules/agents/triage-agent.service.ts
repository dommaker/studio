// Triage Agent Service — incident response: diagnose → classify → act → resolve/escalate
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { classifySystemError } from '../triage/error-class.js';
import type { SystemTriageResult } from '../triage/error-class.js';
import type { TriageIncidentInput, TriageLogEntry } from './types.js';

const MAX_TRIAGE_TIME_MS = 10 * 60_000; // 10 min
const MAX_FIX_ATTEMPTS = 3;
const FIX_COOLDOWN_MS = 30_000; // 30s between attempts

interface PhaseResult {
  success: boolean;
  log: TriageLogEntry;
  diagnosis?: string;
  triage?: SystemTriageResult;
}

class TriageAgent {
  async handleAlert(input: TriageIncidentInput): Promise<{
    incidentId: string;
    resolved: boolean;
    resolution?: string;
  }> {
    const startedAt = Date.now();
    const incidentId = `I-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;

    const incident = await prisma.incident.create({
      data: {
        id: incidentId,
        type: input.type,
        severity: input.severity,
        status: 'diagnosing',
        triageLog: '[]',
      },
    });

    eventBus.publish('incident.created', { incident });
    logger.info('[TriageAgent] Incident created', { incidentId, type: input.type });

    const triageLog: TriageLogEntry[] = [];

    try {
      // Phase 1: DIAGNOSE
      const diagResult = await this.diagnose(input);
      triageLog.push(diagResult.log);
      await this.appendLog(incidentId, triageLog);

      if (this.timedOut(startedAt)) {
        return await this.forceEscalate(incidentId, triageLog, 'Diagnosis timed out');
      }

      // Phase 2: CLASSIFY
      const classifyResult = this.classify(input, diagResult.diagnosis || '');
      triageLog.push(classifyResult.log);

      if (classifyResult.triage?.severity === 'minor') {
        // Minor issues: log and close without action
        await this.resolve(incidentId, triageLog, 'Minor issue, auto-resolved without action');
        return { incidentId, resolved: true, resolution: 'minor_no_action' };
      }

      // Phase 3: ACT (up to 3 attempts)
      // 执行级事件中 session 耗尽无法自动修复 → 直接 escalate
      if (input.type === 'execution_session_exhausted' || input.type === 'review_cycle_exhausted') {
        return await this.escalate(incidentId, triageLog, classifyResult.triage);
      }

      let resolved = false;
      for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        if (this.timedOut(startedAt)) break;

        const actResult = await this.act(input.type, attempt);
        triageLog.push(actResult.log);
        await this.appendLog(incidentId, triageLog);

        if (actResult.success) {
          resolved = true;
          break;
        }

        if (attempt < MAX_FIX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, FIX_COOLDOWN_MS));
        }
      }

      // Phase 4: RESOLVE or ESCALATE
      if (resolved) {
        await this.resolve(incidentId, triageLog, classifyResult.diagnosis || 'Fixed');
        return { incidentId, resolved: true, resolution: classifyResult.diagnosis };
      } else {
        return await this.escalate(incidentId, triageLog, classifyResult.triage);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[TriageAgent] Fatal error', { incidentId, error: errMsg });
      return await this.forceEscalate(incidentId, triageLog, `Fatal: ${errMsg}`);
    }
  }

  // ── Phase 1: Diagnose ──

  private async diagnose(input: TriageIncidentInput): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const findings: string[] = [];

    try {
      // Service health check
      if (input.type === 'service_down' || input.type === 'pipeline_health_degraded') {
        try {
          const { execSync } = await import('child_process');
          const health = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${process.env.PORT || 3001}/health 2>/dev/null || echo "unreachable"`, {
            timeout: 5000,
            encoding: 'utf-8',
          }).trim();
          findings.push(`Health check: ${health}`);
        } catch {
          findings.push('Health check: unreachable');
        }
      }

      // Disk usage
      try {
        const { execSync } = await import('child_process');
        const df = execSync('df -h / | tail -1', { timeout: 3000, encoding: 'utf-8' }).trim();
        findings.push(`Disk: ${df}`);
      } catch {
        findings.push('Disk check: failed');
      }

      // Memory
      try {
        const { execSync } = await import('child_process');
        const free = execSync('free -m | grep Mem', { timeout: 3000, encoding: 'utf-8' }).trim();
        findings.push(`Memory: ${free}`);
      } catch {
        findings.push('Memory check: failed');
      }

      // Process list (zombies)
      try {
        const { execSync } = await import('child_process');
        const zombies = execSync("ps aux | grep -w Z | head -5", { timeout: 3000, encoding: 'utf-8' }).trim();
        if (zombies) findings.push(`Zombies: ${zombies}`);
      } catch {
        // No zombies is normal (grep returns non-zero)
      }

      // Cross-execution pattern diagnosis (Phase 3: Auditor)
      if (input.type === 'agent_type_failure_trend') {
        try {
          const runningCount = await prisma.goalExecution.count({ where: { status: { in: ['running', 'pending'] } } });
          findings.push(`Running/pending executions: ${runningCount}`);
        } catch {
          findings.push('Unable to query execution counts');
        }
        if (input.details?.failingAgentType) {
          findings.push(`Failing agent type: ${input.details.failingAgentType}`);
        }
        if (input.details?.failureRate) {
          findings.push(`Failure rate: ${input.details.failureRate}%`);
        }
      }

      // Execution-level diagnosis (Monitor 升级，FL-037 Phase 1)
      if (input.type.startsWith('execution_') || input.type === 'zombie') {
        try {
          const { execSync } = await import('child_process');
          // Tmux sessions
          const tmux = execSync('tmux ls 2>/dev/null || echo "no tmux server"', { timeout: 3000, encoding: 'utf-8' }).trim();
          findings.push(`Tmux: ${tmux}`);
        } catch {
          findings.push('Tmux: no server');
        }

        try {
          const { execSync } = await import('child_process');
          // Active claude processes
          const claude = execSync('ps aux | grep -c "[c]laude" 2>/dev/null || echo "0"', { timeout: 3000, encoding: 'utf-8' }).trim();
          findings.push(`Claude procs: ${claude}`);
        } catch {
          findings.push('Claude procs: unknown');
        }

        // Execution details from input
        if (input.details?.executionId) {
          findings.push(`ExecID: ${input.details.executionId}`);
        }
        if (input.details?.projectId) {
          findings.push(`Project: ${input.details.projectId}`);
        }
        if (input.details?.monitorSource) {
          findings.push(`Source: ${input.details.monitorSource}`);
        }
      }

      const diagnosis = findings.join(' | ');
      return {
        success: true,
        diagnosis,
        log: {
          time: new Date().toISOString(),
          phase: 'diagnose',
          action: `Checked system metrics for ${input.type}`,
          result: diagnosis.slice(0, 500),
          durationMs: Date.now() - phaseStart,
        },
      };
    } catch (e) {
      return {
        success: false,
        log: {
          time: new Date().toISOString(),
          phase: 'diagnose',
          action: `System check failed`,
          result: String(e),
          durationMs: Date.now() - phaseStart,
        },
      };
    }
  }

  // ── Phase 2: Classify ──

  private classify(input: TriageIncidentInput, diagnosis: string): {
    log: TriageLogEntry;
    diagnosis?: string;
    triage: SystemTriageResult;
  } {
    const triage = classifySystemError(input.type, diagnosis);
    return {
      diagnosis: `${triage.errorClass} (${triage.severity})`,
      triage,
      log: {
        time: new Date().toISOString(),
        phase: 'classify',
        action: `Classified as ${triage.errorClass}`,
        result: `${triage.severity} → ${triage.recommendedAction}`,
      },
    };
  }

  // ── Phase 3: Act ──

  private async act(incidentType: string, attempt: number): Promise<PhaseResult> {
    const phaseStart = Date.now();

    const actions: Record<string, string[]> = {
      // 系统级（已有）
      service_down: ['echo "[Triage] service_down detected - logging only, no auto-restart"'],
      resource_critical: ['rm -rf /tmp/studio-* 2>/dev/null; find /var/log -name "*.log" -mtime +7 -delete 2>/dev/null || true'],
      ext_dependency: ['echo "wait and retry"'],
      zombie: ['pkill -9 -f defunct 2>/dev/null || true'],
      // 执行级（Monitor 升级，FL-037 Phase 1）
      execution_repeated_failure: [
        // Attempt 1: kill stuck session + clean worktree + re-spawn（由 GoalScheduler 处理）
        'echo "[Triage] execution_repeated_failure — escalated to GoalScheduler for re-spawn with tier upgrade"',
      ],
      execution_stuck: [
        // Attempt 1: kill the stuck tmux session
        'tmux ls 2>/dev/null | grep -E "studio-exec" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null; echo "[Triage] killed stuck tmux sessions"',
      ],
      execution_progress_stagnation: [
        // Attempt 1: check worktree health + kill stale claude processes
        'echo "[Triage] progress stagnation — checking worktree health"; ls /tmp/studio-worktrees/*/.progress.json 2>/dev/null || echo "no worktrees found"',
        // Attempt 2: force kill stale processes
        'pkill -9 -f "claude --print" 2>/dev/null; echo "[Triage] killed stale claude processes"',
      ],
      execution_heartbeat_lost: [
        // Attempt 1: kill tmux session
        'tmux ls 2>/dev/null | grep -E "studio-exec" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null; echo "[Triage] killed heartbeat-lost tmux sessions"',
        // Attempt 2: force re-spawn signal (GoalScheduler 检测到后 re-spawn)
        'echo "[Triage] heartbeat_lost — awaiting GoalScheduler re-spawn"',
      ],
      execution_session_exhausted: [
        // 无法自动修复 — escalate to human (不进入 ACT 阶段)
        'echo "[Triage] session exhausted"',
      ],
      execution_timeout: [
        // Attempt 1: kill + signal re-spawn with tier upgrade
        'tmux ls 2>/dev/null | grep -E "studio-exec" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null; echo "[Triage] killed timeout tmux sessions — awaiting re-spawn"',
      ],
      // 跨执行模式（Phase 3）
      agent_type_failure_trend: [
        'echo "[Triage] agent_type_failure_trend — systemic pattern, logging and escalating to human"',
      ],
      pipeline_health_degraded: [
        'echo "[Triage] pipeline_health_degraded — restarting server"; pm2 restart studio-api 2>/dev/null || true',
        'rm -rf /tmp/studio-* 2>/dev/null; find /var/log -name "*.log" -mtime +7 -delete 2>/dev/null || true',
      ],
      review_cycle_exhausted: [
        'echo "[Triage] review_cycle_exhausted — event-driven, escalating to human"',
      ],
    };

    const commands = actions[incidentType] || actions.service_down;
    const cmdIndex = Math.min(attempt - 1, commands.length - 1);
    const cmd = commands[cmdIndex];

    try {
      const { execSync } = await import('child_process');
      const output = execSync(cmd, { timeout: 10000, encoding: 'utf-8' }).trim();

      // Verify with health check after restart-type actions
      let verified = true;
      if (incidentType === 'service_down') {
        try {
          const health = execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${process.env.PORT || 3001}/health 2>/dev/null || echo "0"`, {
            timeout: 5000,
            encoding: 'utf-8',
          }).trim();
          verified = health.startsWith('2');
        } catch {
          verified = false;
        }
      }

      return {
        success: verified,
        log: {
          time: new Date().toISOString(),
          phase: 'act',
          action: `Attempt ${attempt}: ${cmd.slice(0, 80)}`,
          result: verified ? 'Success' : `Command ran but verification failed: ${output.slice(0, 200)}`,
          durationMs: Date.now() - phaseStart,
        },
      };
    } catch (e) {
      return {
        success: false,
        log: {
          time: new Date().toISOString(),
          phase: 'act',
          action: `Attempt ${attempt}: ${cmd.slice(0, 80)}`,
          result: `Failed: ${String(e).slice(0, 200)}`,
          durationMs: Date.now() - phaseStart,
        },
      };
    }
  }

  // ── Phase 4: Resolve / Escalate ──

  private async resolve(
    incidentId: string,
    triageLog: TriageLogEntry[],
    resolution: string,
  ) {
    triageLog.push({
      time: new Date().toISOString(),
      phase: 'resolve',
      action: 'Incident resolved',
      result: resolution,
    });

    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolution,
        triageLog: JSON.stringify(triageLog),
      },
    });

    eventBus.publish('incident.resolved', { incidentId, resolution });
    logger.info('[TriageAgent] Incident resolved', { incidentId, resolution });
    return { incidentId, resolved: true, resolution };
  }

  private async escalate(
    incidentId: string,
    triageLog: TriageLogEntry[],
    triage?: SystemTriageResult,
  ) {
    triageLog.push({
      time: new Date().toISOString(),
      phase: 'escalate',
      action: 'Escalating to human',
      result: triage ? `${triage.errorClass} / ${triage.recommendedAction}` : 'Max attempts exhausted',
    });

    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: 'escalated',
        escalatedTo: 'human',
        resolution: 'Escalated to human for manual intervention',
        triageLog: JSON.stringify(triageLog),
      },
    });

    eventBus.publish('incident.escalated', { incidentId, triage });
    logger.warn('[TriageAgent] Incident escalated', { incidentId });
    return { incidentId, resolved: false, resolution: 'escalated_to_human' };
  }

  private async forceEscalate(
    incidentId: string,
    triageLog: TriageLogEntry[],
    reason: string,
  ) {
    triageLog.push({
      time: new Date().toISOString(),
      phase: 'escalate',
      action: 'Force escalate',
      result: reason,
    });

    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: 'escalated',
        escalatedTo: 'human',
        resolution: reason,
        triageLog: JSON.stringify(triageLog),
      },
    });

    eventBus.publish('incident.escalated', { incidentId, reason });
    logger.error('[TriageAgent] Force escalated', { incidentId, reason });
    return { incidentId, resolved: false, resolution: reason };
  }

  // ── Helpers ──

  private timedOut(startedAt: number): boolean {
    return Date.now() - startedAt > MAX_TRIAGE_TIME_MS;
  }

  private async appendLog(incidentId: string, triageLog: TriageLogEntry[]): Promise<void> {
    try {
      await prisma.incident.update({
        where: { id: incidentId },
        data: { triageLog: JSON.stringify(triageLog) },
      });
    } catch {
      // Non-fatal: log update failure shouldn't abort triage
    }
  }
}

export const triageAgent = new TriageAgent();
