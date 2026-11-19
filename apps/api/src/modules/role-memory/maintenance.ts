/**
 * #718 角色记忆维护运行记录：意图先于副作用，运行中状态可由启动恢复重放。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from '@dommaker/studio-shared';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';
import { roleMemoryDir, roleMemoryRoot, roleMemoryStore, type RoleMemoryStore, type CapacityCheck } from './role-memory.js';

export type RoleMemoryOperation =
  | { type: 'promote'; entryIds: string[] }
  | { type: 'merge'; targetSlug: string; sourceSlugs: string[] }
  | { type: 'archive' | 'restore'; slugs: string[] }
  | { type: 'capacity' };

export type MaintenanceStatus = 'triggered' | 'running' | 'succeeded' | 'failed';

export interface RoleMemoryMaintenanceRun {
  id: string;
  roleId: string;
  operation: RoleMemoryOperation;
  status: MaintenanceStatus;
  attempts: number;
  updatedAt: string;
  lastError?: string;
  result?: { promoted?: number; topicsUpdated?: string[]; capacity?: CapacityCheck };
}

export class RoleMemoryMaintenance {
  constructor(
    private readonly memory: RoleMemoryStore = roleMemoryStore,
    private readonly fileStore: FileStore = getStore(),
  ) {}

  private runsPath(roleId: string): string {
    return path.join(roleMemoryDir(roleId), 'maintenance.jsonl');
  }

  private async append(run: RoleMemoryMaintenanceRun): Promise<void> {
    await this.fileStore.appendJsonl(this.runsPath(run.roleId), run);
  }

  async listRuns(roleId: string): Promise<RoleMemoryMaintenanceRun[]> {
    const rows = await this.fileStore.readJsonl<RoleMemoryMaintenanceRun>(this.runsPath(roleId));
    const latest = new Map<string, RoleMemoryMaintenanceRun>();
    for (const row of rows) latest.set(row.id, row);
    return [...latest.values()];
  }

  async getRun(roleId: string, runId: string): Promise<RoleMemoryMaintenanceRun | null> {
    return (await this.listRuns(roleId)).find(run => run.id === runId) ?? null;
  }

  async execute(roleId: string, operation: RoleMemoryOperation, runId: string = randomUUID()): Promise<RoleMemoryMaintenanceRun> {
    const previous = await this.getRun(roleId, runId);
    if (previous?.status === 'succeeded') return previous;
    const attempts = (previous?.attempts ?? 0) + 1;
    const base = { id: runId, roleId, operation, attempts };
    await this.append({ ...base, status: 'triggered', updatedAt: new Date().toISOString() });
    await this.append({ ...base, status: 'running', updatedAt: new Date().toISOString() });
    try {
      let result: RoleMemoryMaintenanceRun['result'];
      if (operation.type === 'promote') {
        result = await this.memory.promote(roleId, operation.entryIds);
      } else if (operation.type === 'merge') {
        await this.memory.mergeTopics(roleId, operation.targetSlug, operation.sourceSlugs);
        result = { topicsUpdated: [operation.targetSlug, ...operation.sourceSlugs] };
      } else if (operation.type === 'archive' || operation.type === 'restore') {
        for (const slug of operation.slugs) {
          await this.memory.setLifecycleStatus(roleId, slug, operation.type === 'archive' ? 'archived' : 'active');
        }
        result = { topicsUpdated: operation.slugs };
      } else {
        const topics = await this.memory.listTopics(roleId);
        for (const topic of topics.filter(item => item.status === 'stale' || item.supersededBy)) {
          await this.memory.setLifecycleStatus(roleId, topic.slug, 'archived');
        }
        result = { capacity: await this.memory.checkCapacity(roleId) };
      }
      const succeeded: RoleMemoryMaintenanceRun = {
        ...base, status: 'succeeded', result, updatedAt: new Date().toISOString(),
      };
      await this.append(succeeded);
      return succeeded;
    } catch (error) {
      await this.append({
        ...base, status: 'failed', lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async recoverPending(): Promise<void> {
    let entries;
    try {
      entries = await this.fileStore.readdir(roleMemoryRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.filter(item => item.isDirectory())) {
      const runs = await this.listRuns(entry.name);
      for (const run of runs.filter(item =>
        item.status === 'triggered' || item.status === 'running' || (item.status === 'failed' && item.attempts < 3))) {
        await this.execute(run.roleId, run.operation, run.id).catch(error => {
          logger.warn('[RoleMemoryMaintenance] recovery failed (non-blocking)', {
            roleId: run.roleId, runId: run.id, error: String(error),
          });
        });
      }
    }
  }
}

export const roleMemoryMaintenance = new RoleMemoryMaintenance();
