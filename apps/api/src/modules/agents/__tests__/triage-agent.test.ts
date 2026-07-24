// TriageAgent + MonitorAgent integration test
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';

// In-memory incident store for mock FileStore (replaces mock Prisma)
const incidentStore: any[] = [];

const mockFileStore = {
  appendJsonl: vi.fn((_path: string, data: any) => {
    incidentStore.push(data);
    return Promise.resolve();
  }),
  readJsonl: vi.fn(() => {
    return Promise.resolve(incidentStore); // return reference, not copy — so updates are visible
  }),
  getIndex: vi.fn().mockResolvedValue([]),
  readJson: vi.fn().mockResolvedValue(null),
  writeJson: vi.fn().mockResolvedValue(undefined),
};

// Mock fs.promises to no-op (FileStore writeFile calls go to real fs, mocked here)
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs') as any;
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () { return mockFileStore; }),
  };
});

const mockPrisma = {
  task: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  studioEvent: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  session: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
};

vi.mock('@dommaker/studio-prisma', () => ({ prisma: mockPrisma }));

// Use dynamic import after mock setup
const { triageAgent } = await import('../triage-agent.service.js');
const { systemHealthCheck } = await import('../monitor-system-probes.js');

describe('TriageAgent + MonitorAgent', () => {
  beforeEach(() => {
    incidentStore.length = 0;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    incidentStore.length = 0;
  });

  // ── systemHealthCheck ──

  describe('systemProbes.systemHealthCheck()', () => {
    it('returns array (may be empty or contain anomalies)', async () => {
      const anomalies = await systemHealthCheck();
      expect(Array.isArray(anomalies)).toBe(true);
    });

    it('anomalies have correct shape', async () => {
      const anomalies = await systemHealthCheck();
      for (const a of anomalies) {
        expect(a).toHaveProperty('type');
        expect(a).toHaveProperty('severity');
        expect(a).toHaveProperty('message');
        expect(['service_down', 'resource_critical', 'ext_dependency', 'zombie']).toContain(a.type);
        expect(['critical', 'warning']).toContain(a.severity);
      }
    });
  });

  // ── handleAlert cross-execution ──

  describe('TriageAgent.handleAlert()', () => {
    // Helper: find incident from in-memory store
    function findIncident(id: string): any {
      return incidentStore.find((i: any) => i.id === id) || null;
    }
    // Helper: remove incident from in-memory store
    function removeIncident(id: string): void {
      const idx = incidentStore.findIndex((i: any) => i.id === id);
      if (idx !== -1) incidentStore.splice(idx, 1);
    }

    it('creates an Incident record with valid ID format', async () => {
      // Use resource_critical - avoids ACT phase (resolves immediately as minor)
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Test: disk at 92%',
      });

      expect(result.incidentId).toMatch(/^I-\d{8}-/);

      const incident = findIncident(result.incidentId);
      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('resource_critical');
      expect(incident!.severity).toBe('warning');

      removeIncident(result.incidentId);
    });

    it('reaches terminal state (resolved or escalated)', async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Test: disk at 91%',
      });

      const incident = findIncident(result.incidentId);
      expect(incident).not.toBeNull();
      expect(['resolved', 'escalated']).toContain(incident!.status);

      if (result.resolved) {
        expect(incident!.resolution).toBeTruthy();
        expect(incident!.resolvedAt).toBeTruthy();
      } else {
        expect(incident!.escalatedTo).toBe('human');
      }

      removeIncident(result.incidentId);
    });

    it('writes structured triageLog as JSON array', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Disk at 95%',
      });

      const incident = findIncident(result.incidentId);
      // triageLog is stored as JSON string in jsonl; updateIncident writes it back as string
      const logs = typeof incident!.triageLog === 'string'
        ? JSON.parse(incident!.triageLog)
        : incident!.triageLog;
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
      for (const entry of logs) {
        expect(entry).toHaveProperty('phase');
        expect(entry).toHaveProperty('action');
        expect(entry).toHaveProperty('result');
        expect(entry).toHaveProperty('time');
      }

      removeIncident(result.incidentId);
    });

    it('includes diagnose and classify phases in triageLog', async () => {
      const result = await triageAgent.handleAlert({
        type: 'resource_critical',
        severity: 'warning',
        message: 'Disk at 93%',
      });

      const incident = findIncident(result.incidentId);
      const logs = typeof incident!.triageLog === 'string'
        ? JSON.parse(incident!.triageLog)
        : incident!.triageLog;
      const phases = logs.map((l: any) => l.phase);
      expect(phases).toContain('diagnose');
      expect(phases).toContain('classify');
      expect(phases.some((p: string) => p === 'resolve' || p === 'escalate')).toBe(true);

      removeIncident(result.incidentId);
    });

    // ── 执行级事件处理 (FL-037 Phase 1) ──

    it('handles execution_stuck type and reaches terminal state', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'execution_stuck',
        severity: 'critical',
        message: 'Test: execution stuck 35min',
        details: { executionId: 'test-exec-1', monitorSource: 'stuck_workunits' },
      });

      expect(result.incidentId).toMatch(/^I-\d{8}-/);

      const incident = findIncident(result.incidentId);
      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('execution_stuck');
      expect(['resolved', 'escalated']).toContain(incident!.status);

      removeIncident(result.incidentId);
    });

    it('handles execution_session_exhausted and escalates to human', { timeout: 30000 }, async () => {
      const result = await triageAgent.handleAlert({
        type: 'execution_session_exhausted',
        severity: 'critical',
        message: 'Test: 5 sessions exhausted',
      });

      const incident = findIncident(result.incidentId);
      expect(incident!.type).toBe('execution_session_exhausted');
      // session_exhausted has no auto-fix -> should escalate
      expect(incident!.escalatedTo).toBe('human');

      removeIncident(result.incidentId);
    });
  });

  // ── classifySystemError ──

  describe('classifySystemError()', () => {
    it('maps service_down -> timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('service_down', 'unreachable');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });

    it('maps zombie -> timeout (degraded)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('zombie', 'defunct');
      expect(r.errorClass).toBe('timeout');
    });

    it('maps ext_dependency -> vendor_error (critical)', async () => {
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

    it('maps execution_repeated_failure -> timeout (degraded)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_repeated_failure', 'same step failed 3 times');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('degraded');
      expect(r.recommendedAction).toContain('tier upgrade');
    });

    it('maps execution_heartbeat_lost -> timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_heartbeat_lost', 'heartbeat lost 30min');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });

    it('maps execution_session_exhausted -> env_error (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_session_exhausted', '5 sessions exhausted');
      expect(r.errorClass).toBe('env_error');
      expect(r.severity).toBe('critical');
    });

    it('maps execution_timeout -> timeout (critical)', async () => {
      const { classifySystemError } = await import('../../triage/error-class.js');
      const r = classifySystemError('execution_timeout', 'execution over 2.5h');
      expect(r.errorClass).toBe('timeout');
      expect(r.severity).toBe('critical');
    });
  });
});
