/**
 * Process I/O utilities — spawn, session-id persistence, phase bridge
 *
 * Node.js only (uses child_process, fs, crypto).
 * Import via: import { execSh, resolveSessionId } from '@dommaker/studio-shared/node'
 *
 * 注：.progress.json 的读取与 ProgressReport 类型唯一属主在
 * studio-agent services/output-capture.ts（#357 双头收口，此处旧版已删）。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface ExecShOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer?: number;
  childRef?: { current: ChildProcess | null };
  /** Content to pipe to child's stdin. When set, stdio uses 'pipe' for stdin. */
  stdin?: string;
  /**
   * 行级 stdout 回调（Layer B 步内流式）：每个完整行到达即回调（不等进程结束），
   * 进程关闭时冲刷无换行结尾的尾部。回调异常被吞掉——绝不影响被观测进程。
   * 与 stdout 聚合返回值并行存在，互不影响。
   */
  onLine?: (line: string) => void;
  /**
   * #171（#54 决议）：杀 = 杀进程组。detached spawn 使 bash 成为进程组组长，
   * 所有杀路径（墙钟/静默/maxBuffer）用 kill(-pid, SIGKILL) 整组直杀——#68 实测
   * SIGTERM 只杀直接子进程，孙进程孤儿化继续烧 token 26s~36min。
   */
  killProcessGroup?: boolean;
  /**
   * #171（#54 决议）：静默看门狗。判据 = 距最后一次输出（stdout/stderr）间隔；
   * 任何输出即复位。超 warnMs 报 warn（每段静默恰一次），超 killMs 杀进程并 reject。
   */
  silence?: SilenceWatchdogOptions;
}

export interface SilenceWatchdogOptions {
  /** 距最后一次输出超过该毫秒数 → onWarn（每段静默恰报一次，输出复位后可再报） */
  warnMs?: number;
  /** 距最后一次输出超过该毫秒数 → 杀进程并 reject */
  killMs: number;
  /** warn 观测回调（异常被吞，绝不影响被观测进程） */
  onWarn?: (silentMs: number) => void;
}

export interface SessionIdOptions {
  sessionIdFile?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Spawn ──────────────────────────────────────────────────────

/**
 * Spawn a shell command via bash -c.
 * Throws on non-zero exit or timeout. Supports maxBuffer and childRef.
 */
export function execSh(
  cmd: string,
  opts: ExecShOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // #171: detached 使 bash 成为进程组组长，kill(-pid) 才能覆盖整组（含孙进程）
      detached: opts.killProcessGroup === true,
    });

    if (opts.childRef) {
      opts.childRef.current = child;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let lineBuf = '';

    // #171（#54 决议）：进程组杀 —— 组杀用 SIGKILL 直杀（挂死进程不给清理窗口，
    // #68 实测 SIGTERM 杀不死孙进程）；未开 killProcessGroup 时保持 legacy 信号语义。
    const killChild = (legacySignal: NodeJS.Signals): void => {
      if (opts.killProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch { /* ESRCH（组已退）→ 兜底杀直接子进程 */ }
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        return;
      }
      child.kill(legacySignal);
    };

    // #171（#54 决议）：静默看门狗 —— 判据 = 距最后一次输出（stdout/stderr）间隔，
    // 任何输出即复位（健康步内最大静默 p99=215s / 极值 305s，均来自长 Bash 调用）。
    let lastActivityAt = Date.now();
    let silenceWarned = false;
    let silenceTimer: NodeJS.Timeout | null = null;
    const clearSilenceTimer = (): void => {
      if (silenceTimer) {
        clearInterval(silenceTimer);
        silenceTimer = null;
      }
    };
    if (opts.silence) {
      const { warnMs, killMs } = opts.silence;
      const checkMs = Math.max(50, Math.floor(Math.min(warnMs ?? killMs, killMs) / 10));
      silenceTimer = setInterval(() => {
        if (settled) return;
        const silentMs = Date.now() - lastActivityAt;
        if (warnMs !== undefined && !silenceWarned && silentMs >= warnMs) {
          silenceWarned = true;
          try { opts.silence!.onWarn?.(silentMs); } catch { /* 观测回调异常绝不影响被观测进程 */ }
        }
        if (silentMs >= killMs) {
          settled = true;
          clearTimeout(timeout);
          clearSilenceTimer();
          killChild('SIGKILL');
          if (opts.childRef) opts.childRef.current = null;
          reject(new Error(`Command killed after ${Math.round(silentMs / 1000)}s of silence (no output)`));
        }
      }, checkMs);
      silenceTimer.unref();
    }

    const emitLine = (line: string) => {
      if (!opts.onLine) return;
      try {
        opts.onLine(line);
      } catch { /* 观测回调异常绝不影响被观测进程 */ }
    };

    child.stdout?.on('data', (data: Buffer) => {
      lastActivityAt = Date.now();
      silenceWarned = false;
      const chunk = data.toString();
      stdout += chunk;
      if (opts.onLine) {
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          emitLine(line);
        }
      }
      if (opts.maxBuffer && stdout.length > opts.maxBuffer) {
        settled = true;
        killChild('SIGTERM');
        if (opts.childRef) opts.childRef.current = null;
        reject(new Error(`stdout maxBuffer (${opts.maxBuffer / 1024 / 1024}MB) exceeded`));
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      lastActivityAt = Date.now();
      silenceWarned = false;
      stderr += data.toString();
    });

    // Pipe stdin content if provided, then close stdin
    if (opts.stdin && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE: child exited before consuming stdin — not actionable
        if (err.code !== 'EPIPE') reject(err);
      });
      child.stdin.write(opts.stdin, (err) => {
        // err: EPIPE if child already exited — safe to ignore in that case
        if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
          if (!settled) { settled = true; clearTimeout(timeout); reject(err as Error); }
        }
      });
      child.stdin.end();
    }

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearSilenceTimer();
        killChild('SIGTERM');
        if (opts.childRef) opts.childRef.current = null;
        reject(new Error(`Command timed out after ${Math.round(opts.timeoutMs / 60000)}min`));
      }
    }, opts.timeoutMs);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearSilenceTimer();
        if (opts.childRef) opts.childRef.current = null;
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      clearSilenceTimer();
      if (opts.childRef) opts.childRef.current = null;
      // 冲刷无换行结尾的尾部行（超时/maxBuffer 等已 settle 路径同样冲刷——尾部对观测仍有价值）
      if (opts.onLine && lineBuf.length > 0) {
        const tail = lineBuf;
        lineBuf = '';
        emitLine(tail);
      }
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const err = new Error(`Command exited with ${reason}: ${(stderr || stdout).slice(0, 200)}`) as any;
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
  });
}

// ─── Session ID ─────────────────────────────────────────────────

/**
 * Read or generate a persistent session UUID.
 * Default path: <worktree>/.daemon/session-id
 */
export function resolveSessionId(worktree: string, opts?: SessionIdOptions): string {
  const sessionFile = opts?.sessionIdFile ?? path.join(worktree, '.daemon', 'session-id');

  try {
    const existing = fs.readFileSync(sessionFile, 'utf-8').trim();
    if (UUID_REGEX.test(existing)) {
      return existing;
    }
  } catch {
    // File doesn't exist or unreadable — generate new
  }

  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, id, 'utf-8');
  return id;
}

export function readSessionIdFile(worktree: string, opts?: SessionIdOptions): string | null {
  const sessionFile = opts?.sessionIdFile ?? path.join(worktree, '.daemon', 'session-id');
  try {
    const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
    return UUID_REGEX.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// ─── Phase Bridge ───────────────────────────────────────────────

export interface PhaseBridge {
  currentPhase: string;
  previousPhase?: string;
  worktreePath?: string;
  timestamp: string;
}

/**
 * Read .phase-bridge.json. Default path: <worktree | cwd>/.phase-bridge.json
 */
export function readPhaseBridge(worktree?: string): PhaseBridge | null {
  const file = path.join(worktree ?? '.', '.phase-bridge.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as PhaseBridge;
  } catch {
    return null;
  }
}
