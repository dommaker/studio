/**
 * Process I/O utilities — spawn, session-id persistence, file bridge
 *
 * Node.js only (uses child_process, fs, crypto).
 * Import via: import { execSh, resolveSessionId, readProgress } from '@dommaker/studio-shared/node'
 */
import { type ChildProcess } from 'child_process';
export interface ExecShOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer?: number;
    childRef?: {
        current: ChildProcess | null;
    };
    /** Content to pipe to child's stdin. When set, stdio uses 'pipe' for stdin. */
    stdin?: string;
    /**
     * 行级 stdout 回调（Layer B 步内流式）：每个完整行到达即回调（不等进程结束），
     * 进程关闭时冲刷无换行结尾的尾部。回调异常被吞掉——绝不影响被观测进程。
     * 与 stdout 聚合返回值并行存在，互不影响。
     */
    onLine?: (line: string) => void;
}
export interface SessionIdOptions {
    sessionIdFile?: string;
}
export interface ProgressReport {
    phase: string;
    step: string;
    status: 'running' | 'completed' | 'failed' | 'paused';
    timestamp: string;
    metadata?: Record<string, unknown>;
}
/**
 * Spawn a shell command via bash -c.
 * Throws on non-zero exit or timeout. Supports maxBuffer and childRef.
 */
export declare function execSh(cmd: string, opts: ExecShOptions): Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Read or generate a persistent session UUID.
 * Default path: <worktree>/.daemon/session-id
 */
export declare function resolveSessionId(worktree: string, opts?: SessionIdOptions): string;
export declare function readSessionIdFile(worktree: string, opts?: SessionIdOptions): string | null;
/**
 * Read .progress.json from a worktree. Returns null if missing or corrupt.
 * Default path: <worktree>/.progress.json
 */
export declare function readProgress(worktree: string): ProgressReport | null;
/**
 * Atomic write to .progress.json (tmp + rename). Default path: <worktree>/.progress.json
 */
export declare function writeProgress(worktree: string, report: ProgressReport): void;
export interface PhaseBridge {
    currentPhase: string;
    previousPhase?: string;
    worktreePath?: string;
    timestamp: string;
}
/**
 * Read .phase-bridge.json. Default path: <worktree | cwd>/.phase-bridge.json
 */
export declare function readPhaseBridge(worktree?: string): PhaseBridge | null;
//# sourceMappingURL=process-io.d.ts.map