// Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6)
import { prisma } from '@dommaker/studio-prisma';

export interface AgentSummary {
  agents: Array<{
    id: string;
    name: string;
    status: string;
    currentWorkUnitId: string | null;
    startedAt: string;
  }>;
  summary: {
    total: number;
    idle: number;
    active: number;
    terminated: number;
  };
}

export interface MonitoringStats {
  workunits: {
    total: number;
    unassigned: number;
    active: number;
    in_review: number;
    done: number;
    blocked: number;
    closed: number;
  };
  agents: {
    total: number;
    idle: number;
    active: number;
    terminated: number;
  };
  recent: {
    completedLast24h: number;
    failedLast24h: number;
  };
}

export class MonitoringService {
  async getAgentSummary(): Promise<AgentSummary> {
    const instances = await prisma.runtimeInstance.findMany({
      orderBy: { startedAt: 'desc' },
    });

    // Fetch role names
    const roleIds = [...new Set(instances.map(i => i.roleId))];
    const profiles = await prisma.agentProfile.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, name: true },
    });
    const roleNameMap = new Map(profiles.map(p => [p.id, p.name]));

    const agents = instances.map(inst => ({
      id: inst.id,
      name: roleNameMap.get(inst.roleId) ?? 'unknown',
      status: inst.status,
      currentWorkUnitId: inst.currentWorkUnitId,
      startedAt: inst.startedAt.toISOString(),
    }));

    const summary = {
      total: agents.length,
      idle: agents.filter(a => a.status === 'idle').length,
      active: agents.filter(a => a.status === 'active').length,
      terminated: agents.filter(a => a.status === 'terminated').length,
    };

    return { agents, summary };
  }

  async getStats(): Promise<MonitoringStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalWorkUnits,
      unassigned,
      active,
      inReview,
      done,
      blocked,
      closed,
      totalAgents,
      idleAgents,
      activeAgents,
      terminatedAgents,
      completedLast24h,
      failedLast24h,
    ] = await Promise.all([
      prisma.workUnit.count(),
      prisma.workUnit.count({ where: { status: 'unassigned' } }),
      prisma.workUnit.count({ where: { status: 'active' } }),
      prisma.workUnit.count({ where: { status: 'in_review' } }),
      prisma.workUnit.count({ where: { status: 'done' } }),
      prisma.workUnit.count({ where: { status: 'blocked' } }),
      prisma.workUnit.count({ where: { status: 'closed' } }),
      prisma.runtimeInstance.count(),
      prisma.runtimeInstance.count({ where: { status: 'idle' } }),
      prisma.runtimeInstance.count({ where: { status: 'active' } }),
      prisma.runtimeInstance.count({ where: { status: 'terminated' } }),
      prisma.workUnit.count({ where: { status: 'done', completedAt: { gte: last24h } } }),
      // failedLast24h: blocked (review rejection or dependency) in last 24h
      prisma.workUnit.count({ where: { status: 'blocked', updatedAt: { gte: last24h } } }),
    ]);

    return {
      workunits: { total: totalWorkUnits, unassigned, active, in_review: inReview, done, blocked, closed },
      agents: { total: totalAgents, idle: idleAgents, active: activeAgents, terminated: terminatedAgents },
      recent: { completedLast24h, failedLast24h },
    };
  }
}
