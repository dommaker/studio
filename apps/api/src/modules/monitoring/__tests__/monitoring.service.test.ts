// Contract test: MonitoringService — MVP-2 + MVP-6
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { MonitoringService } from '../monitoring.service.js';

const service = new MonitoringService();

let testProfileId: string;
let testInstanceId: string;

beforeAll(async () => {
  // Create test AgentProfile
  const profile = await prisma.agentProfile.create({
    data: { name: `test-monitor-${Date.now()}`, description: 'test', status: 'active' },
  });
  testProfileId = profile.id;

  // Create test RuntimeInstance
  const instance = await prisma.runtimeInstance.create({
    data: { roleId: testProfileId, status: 'idle' },
  });
  testInstanceId = instance.id;
});

afterAll(async () => {
  await prisma.runtimeInstance.deleteMany({ where: { roleId: testProfileId } });
  await prisma.agentProfile.deleteMany({ where: { id: testProfileId } });
});

describe('MonitoringService.getAgentSummary', () => {
  it('should return agents with status and currentWorkUnitId', async () => {
    const result = await service.getAgentSummary();
    expect(result.agents).toBeDefined();
    expect(result.summary).toBeDefined();

    const agent = result.agents.find(a => a.id === testInstanceId);
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('idle');
    expect(agent!.name).toBeDefined();
    expect(agent!.startedAt).toBeDefined();
  });

  it('should aggregate counts correctly', async () => {
    const result = await service.getAgentSummary();
    expect(result.summary.total).toBeGreaterThanOrEqual(1);
    expect(result.summary.idle).toBeGreaterThanOrEqual(1);
    expect(result.summary.total).toBe(result.summary.idle + result.summary.active + result.summary.terminated);
  });
});

describe('MonitoringService.getStats', () => {
  it('should return workunit counts by status', async () => {
    const result = await service.getStats();
    expect(result.workunits).toBeDefined();
    expect(result.workunits.total).toBeGreaterThanOrEqual(0);
    expect(typeof result.workunits.unassigned).toBe('number');
    expect(typeof result.workunits.active).toBe('number');
    expect(typeof result.workunits.in_review).toBe('number');
    expect(typeof result.workunits.done).toBe('number');
    expect(typeof result.workunits.blocked).toBe('number');
    expect(typeof result.workunits.closed).toBe('number');
  });

  it('should return agent counts by status', async () => {
    const result = await service.getStats();
    expect(result.agents).toBeDefined();
    expect(result.agents.total).toBeGreaterThanOrEqual(1);
    expect(result.agents.total).toBe(result.agents.idle + result.agents.active + result.agents.terminated);
  });

  it('should return recent stats', async () => {
    const result = await service.getStats();
    expect(result.recent).toBeDefined();
    expect(typeof result.recent.completedLast24h).toBe('number');
    expect(typeof result.recent.failedLast24h).toBe('number');
  });
});
