// TriageService destructive-action gating test — STUDIO_TRIAGE_DESTRUCTIVE flag
// 验证：默认（flag off）破坏性命令（rm -rf / pkill / tmux kill-session / find -delete）
// 不会真正执行，只发出 dry-run echo；flag on 时才按原样执行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory incident store for mock FileStore（与 triage-agent.test.ts 同一约定）
const incidentStore: any[] = [];

const mockFileStore = {
  appendJsonl: vi.fn((_path: string, data: any) => {
    incidentStore.push(data);
    return Promise.resolve();
  }),
  readJsonl: vi.fn(() => Promise.resolve(incidentStore)),
  getIndex: vi.fn().mockResolvedValue([]),
  readJson: vi.fn().mockResolvedValue(null),
  writeJson: vi.fn().mockResolvedValue(undefined),
};

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

// 捕获所有 shell 执行：execSync 只记录不执行（service 内为 await import('child_process')）
const execCalls: string[] = [];
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    execCalls.push(cmd);
    return '';
  }),
  // knowledge-service 静态 import execFile（RAG 探测）— 立即回调成功，避免悬挂
  execFile: vi.fn((...args: any[]) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) cb(null, '', '');
    return {};
  }),
}));

const { triageService, guarded } = await import('../triage/triage.service.js');

const DRY_RUN_PREFIX = `echo '[Triage] DRY-RUN`;
// 破坏性 token：出现即说明该命令"含破坏性意图"
const DESTRUCTIVE_RE = /rm -rf|pkill|kill-session|find .* -delete/;

// 会进入 ACT 阶段且 attempt-1 命令为破坏性命令的事件类型
const DESTRUCTIVE_TYPES = [
  'resource_critical',        // rm -rf /tmp/studio-* + find -delete（diagnosis 含 Memory → critical）
  'zombie',                   // pkill -9 -f defunct
  'execution_stuck',          // tmux kill-session
  'execution_timeout',        // tmux kill-session
  'execution_heartbeat_lost', // tmux kill-session
];

describe('TriageService destructive action gating', () => {
  beforeEach(() => {
    incidentStore.length = 0;
    execCalls.length = 0;
    delete process.env.STUDIO_TRIAGE_DESTRUCTIVE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.STUDIO_TRIAGE_DESTRUCTIVE;
  });

  describe('guarded()', () => {
    it('returns dry-run echo when flag is off (default)', () => {
      const dry = guarded('rm -rf /tmp/studio-* 2>/dev/null');
      expect(dry.startsWith(DRY_RUN_PREFIX)).toBe(true);
      expect(dry).toContain('STUDIO_TRIAGE_DESTRUCTIVE');
      expect(dry).toContain('rm -rf /tmp/studio-*'); // 可观测性：说明本会执行什么
    });

    it('returns the raw command when STUDIO_TRIAGE_DESTRUCTIVE=true', () => {
      process.env.STUDIO_TRIAGE_DESTRUCTIVE = 'true';
      expect(guarded('pkill -9 -f defunct 2>/dev/null || true')).toBe('pkill -9 -f defunct 2>/dev/null || true');
    });

    it('treats any value other than "true" as off', () => {
      process.env.STUDIO_TRIAGE_DESTRUCTIVE = '1';
      expect(guarded('rm -rf x')).not.toBe('rm -rf x');
      process.env.STUDIO_TRIAGE_DESTRUCTIVE = 'false';
      expect(guarded('rm -rf x')).not.toBe('rm -rf x');
    });
  });

  describe('flag off (default)', () => {
    for (const type of DESTRUCTIVE_TYPES) {
      it(`${type}: destructive command is NOT executed, only dry-run echo`, { timeout: 30000 }, async () => {
        const result = await triageService.handleAlert({
          type,
          severity: 'critical',
          message: `test ${type}`,
          details: { executionId: 'test-exec-gate', monitorSource: 'test' },
        });
        expect(result.incidentId).toMatch(/^I-\d{8}-/);

        // 1) 没有任何含破坏性意图的命令被直接交给 shell（唯一例外：dry-run echo 文本）
        const unguarded = execCalls.filter(
          (cmd) => DESTRUCTIVE_RE.test(cmd) && !cmd.startsWith(DRY_RUN_PREFIX),
        );
        expect(unguarded).toEqual([]);

        // 2) gating 确实生效：至少有一条 dry-run echo 记录了本会执行的破坏性命令
        const dryRuns = execCalls.filter(
          (cmd) => cmd.startsWith(DRY_RUN_PREFIX) && DESTRUCTIVE_RE.test(cmd),
        );
        expect(dryRuns.length).toBeGreaterThanOrEqual(1);
      });
    }

    it('read-only diagnose commands still run (observability kept)', { timeout: 30000 }, async () => {
      await triageService.handleAlert({
        type: 'execution_stuck',
        severity: 'critical',
        message: 'test read-only diagnose',
        details: { executionId: 'test-exec-gate-2' },
      });
      // diagnose 阶段的 tmux ls / ps / df 等只读命令不受影响
      expect(execCalls.some((c) => c.includes('df -h'))).toBe(true);
      expect(execCalls.some((c) => c.startsWith('tmux ls'))).toBe(true);
    });
  });

  describe('flag on (STUDIO_TRIAGE_DESTRUCTIVE=true)', () => {
    it('executes destructive commands verbatim', { timeout: 60000 }, async () => {
      process.env.STUDIO_TRIAGE_DESTRUCTIVE = 'true';

      await triageService.handleAlert({ type: 'execution_stuck', severity: 'critical', message: 't', details: { executionId: 'e1' } });
      await triageService.handleAlert({ type: 'zombie', severity: 'critical', message: 't' });
      await triageService.handleAlert({ type: 'resource_critical', severity: 'critical', message: 't' });

      const rawDestructive = execCalls.filter(
        (cmd) => DESTRUCTIVE_RE.test(cmd) && !cmd.startsWith(DRY_RUN_PREFIX),
      );
      expect(rawDestructive.some((c) => c.includes('tmux kill-session'))).toBe(true);
      expect(rawDestructive.some((c) => c.includes('pkill -9 -f defunct'))).toBe(true);
      expect(rawDestructive.some((c) => c.includes('rm -rf /tmp/studio-*'))).toBe(true);

      // flag on 时不应出现 dry-run 包装
      expect(execCalls.some((c) => c.startsWith(DRY_RUN_PREFIX))).toBe(false);
    });
  });
});
