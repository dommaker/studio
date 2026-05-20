// TriageAgent + MonitorAgent integration test (SQLite, no Prisma mocks)
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { triageAgent } from '../triage-agent.service.js';
import { monitorAgent } from '../monitor-agent.service.js';

describe('TriageAgent + MonitorAgent', () => {
  afterAll(async () => {
    await prisma.incident.deleteMany({});
  });

  // ── systemHealthCheck ──

  describe('MonitorAgent.systemHealthCheck()', () => {
    it('returns array (may be empty or contain anomalies)', async () => {
      const anomalies = await monitorAgent.systemHealthCheck();
      expect(Array.isArray(anomalies)).toBe(true);
    });

    it('anomalies have correct shape', async () => {
      const anomalies = await monitorAgent.systemHealthCheck();
      for (const a of anomalies) {
        expect(a).toHaveProperty('type');
        expect(a).toHaveProperty('severity');
        expect(a).toHaveProperty('message');
        expect(['service_down', 'resource_critical', 'ext_dependency', 'zombie']).toContain(a.type);
        expect(['critical', 'warning']).toContain(a.severity);
      }
    });
  });

  // ── handleAlert pipeline ──

  describe('TriageAgent.handleAlert()', () => {
    it('creates an Incident record with valid ID format', async () => {
      // Use resource_critical — avoids ACT phase (resolves immediately as minor)
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Test: disk at 92%',
      });

      expect(result.incidentId).toMatch(/^I-\d{8}-/);

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('resource_critical');
      expect(incident!.severity).toBe('warning');

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });

    it('reaches terminal state (resolved or escalated)', async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Test: disk at 91%',
      });

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      expect(incident).not.toBeNull();
      expect(['resolved', 'escalated']).toContain(incident!.status);

      if (result.resolved) {
        expect(incident!.resolution).toBeTruthy();
        expect(incident!.resolvedAt).toBeTruthy();
      } else {
        expect(incident!.escalatedTo).toBe('human');
      }

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });

    it('writes structured triageLog as JSON array', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Disk at 95%',
      });

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      const logs = JSON.parse(incident!.triageLog as string);
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
      for (const entry of logs) {
        expect(entry).toHaveProperty('phase');
        expect(entry).toHaveProperty('action');
        expect(entry).toHaveProperty('result');
        expect(entry).toHaveProperty('time');
      }

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });

    it('includes diagnose and classify phases in triageLog', async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Disk at 93%',
      });

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      const logs = JSON.parse(incident!.triageLog as string);
      const phases = logs.map((l: any) => l.phase);
      expect(phases).toContain('diagnose');
      expect(phases).toContain('classify');
      expect(phases.some((p: string) => p === 'resolve' || p === 'escalate')).toBe(true);

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });

    // ── 执行级事件处理 (FL-037 Phase 1) ──

    it('handles execution_stuck type and reaches terminal state', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'execution_stuck',
        severity: 'critical',
        message: 'Test: execution stuck 35min',
        details: { executionId: 'test-exec-1', monitorSource: 'stuck_goals' },
      });

      expect(result.incidentId).toMatch(/^I-\d{8}-/);

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('execution_stuck');
      expect(['resolved', 'escalated']).toContain(incident!.status);

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });

    it('handles execution_session_exhausted and escalates to human', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'execution_session_exhausted',
        severity: 'critical',
        message: 'Test: 5 sessions exhausted',
      });

      const incident = await prisma.incident.findUnique({
        where: { id: result.incidentId },
      });
      expect(incident!.type).toBe('execution_session_exhausted');
      // session_exhausted has no auto-fix → should escalate
      expect(incident!.escalatedTo).toBe('human');

      await prisma.incident.deleteMany({ where: { id: result.incidentId } });
    });
  });

  // ── classifySystemError ──

  describe('classifySystemError()', () => {
    it('maps service_down → timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('service_down', 'unreachable');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });

    it('maps zombie → timeout (degraded)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('zombie', 'defunct');
      expect(r.errorClass).toBe('timeout');
    });

    it('maps ext_dependency → vendor_error (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('ext_dependency', 'DB timeout');
      expect(r.errorClass).toBe('vendor_error');
      expect(r.severity).toBe('critical');
    });

    it('falls back to env_error for unrecognized patterns', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('resource_critical', 'something else');
      expect(r.errorClass).toBe('env_error');
    });

    // ── 执行级事件分类 (FL-037 Phase 1) ──

    it('maps execution_repeated_failure → timeout (degraded)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_repeated_failure', 'same step failed 3 times');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('degraded');
      expect(r.recommendedAction).toContain('tier upgrade');
    });

    it('maps execution_heartbeat_lost → timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_heartbeat_lost', 'heartbeat lost 30min');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });

    it('maps execution_session_exhausted → env_error (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_session_exhausted', '5 sessions exhausted');
      expect(r.errorClass).toBe('env_error');
      expect(r.severity).toBe('critical');
    });

    it('maps execution_timeout → timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_timeout', 'execution over 2.5h');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });
  });
});
