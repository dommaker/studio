// Monitoring Service — Agent Network aggregation (MVP-2 + MVP-6)
import { FileStore } from '@dommaker/studio-shared';

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

function countByStatus(snapshots: Array<{ status: string; completedAt: string | null; updatedAt: string }>, status: string): number {
  return snapshots.filter(s => s.status === status).length;
}

export class MonitoringService {
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  async getAgentSummary(): Promise<AgentSummary> {
    const states = await this.fileStore.listStates();

    // Sort by startedAt descending
    states.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Fetch role names from FileStore
    const roleIds = [...new Set(states.map(i => i.roleId))];
    const allProfiles = await this.fileStore.listProfiles();
    const profiles = allProfiles.filter(p => roleIds.includes(p.id));
    const roleNameMap = new Map(profiles.map(p => [p.id, p.name]));

    const agents = states.map(inst => ({
      id: inst.id,
      name: roleNameMap.get(inst.roleId) ?? 'unknown',
      status: inst.status,
      currentWorkUnitId: inst.currentWorkUnitId,
      startedAt: inst.startedAt,
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

    // Agent counts from FileStore
    const allStates = await this.fileStore.listStates();
    const totalAgents = allStates.length;
    const idleAgents = allStates.filter(s => s.status === 'idle').length;
    const activeAgents = allStates.filter(s => s.status === 'active').length;
    const terminatedAgents = allStates.filter(s => s.status === 'terminated').length;

    // WorkUnit counts from FileStore
    const snapshots = await this.fileStore.getIndex();

    const totalWorkUnits = snapshots.length;
    const unassigned = countByStatus(snapshots, 'unassigned');
    const active = countByStatus(snapshots, 'active');
    const inReview = countByStatus(snapshots, 'in_review');
    const done = countByStatus(snapshots, 'done');
    const blocked = countByStatus(snapshots, 'blocked');
    const closed = countByStatus(snapshots, 'closed');

    const last24hMs = last24h.getTime();
    const completedLast24h = snapshots.filter(s =>
      s.status === 'done' && s.completedAt && new Date(s.completedAt).getTime() >= last24hMs
    ).length;
    const failedLast24h = snapshots.filter(s =>
      s.status === 'blocked' && new Date(s.updatedAt).getTime() >= last24hMs
    ).length;

    return {
      workunits: { total: totalWorkUnits, unassigned, active, in_review: inReview, done, blocked, closed },
      agents: { total: totalAgents, idle: idleAgents, active: activeAgents, terminated: terminatedAgents },
      recent: { completedLast24h, failedLast24h },
    };
  }
}
