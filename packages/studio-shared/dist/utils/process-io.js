/**
 * Process I/O utilities — spawn, session-id persistence, file bridge
 *
 * Node.js only (uses child_process, fs, crypto).
 * Import via: import { execSh, resolveSessionId, readProgress } from '@dommaker/studio-shared/node'
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ─── Spawn ──────────────────────────────────────────────────────
/**
 * Spawn a shell command via bash -c.
 * Throws on non-zero exit or timeout. Supports maxBuffer and childRef.
 */
export function execSh(cmd, opts) {
    return new Promise((resolve, reject) => {
        const child = spawn('bash', ['-c', cmd], {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
        if (opts.childRef) {
            opts.childRef.current = child;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
            if (opts.maxBuffer && stdout.length > opts.maxBuffer) {
                settled = true;
                child.kill();
                if (opts.childRef)
                    opts.childRef.current = null;
                reject(new Error(`stdout maxBuffer (${opts.maxBuffer / 1024 / 1024}MB) exceeded`));
            }
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        // Pipe stdin content if provided, then close stdin
        if (opts.stdin && child.stdin) {
            child.stdin.on('error', (err) => {
                // EPIPE: child exited before consuming stdin — not actionable
                if (err.code !== 'EPIPE')
                    reject(err);
            });
            child.stdin.write(opts.stdin, (err) => {
                // err: EPIPE if child already exited — safe to ignore in that case
                if (err && err.code !== 'EPIPE') {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                }
            });
            child.stdin.end();
        }
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
                if (opts.childRef)
                    opts.childRef.current = null;
                reject(new Error(`Command timed out after ${Math.round(opts.timeoutMs / 60000)}min`));
            }
        }, opts.timeoutMs);
        child.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                if (opts.childRef)
                    opts.childRef.current = null;
                reject(err);
            }
        });
        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            if (opts.childRef)
                opts.childRef.current = null;
            if (settled)
                return;
            settled = true;
            if (code === 0) {
                resolve({ stdout, stderr });
            }
            else {
                const reason = signal ? `signal ${signal}` : `code ${code}`;
                const err = new Error(`Command exited with ${reason}: ${(stderr || stdout).slice(0, 200)}`);
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
export function resolveSessionId(worktree, opts) {
    const sessionFile = opts?.sessionIdFile ?? path.join(worktree, '.daemon', 'session-id');
    try {
        const existing = fs.readFileSync(sessionFile, 'utf-8').trim();
        if (UUID_REGEX.test(existing)) {
            return existing;
        }
    }
    catch {
        // File doesn't exist or unreadable — generate new
    }
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, id, 'utf-8');
    return id;
}
export function readSessionIdFile(worktree, opts) {
    const sessionFile = opts?.sessionIdFile ?? path.join(worktree, '.daemon', 'session-id');
    try {
        const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
        return UUID_REGEX.test(raw) ? raw : null;
    }
    catch {
        return null;
    }
}
// ─── Progress File ──────────────────────────────────────────────
/**
 * Read .progress.json from a worktree. Returns null if missing or corrupt.
 * Default path: <worktree>/.progress.json
 */
export function readProgress(worktree) {
    try {
        const raw = fs.readFileSync(path.join(worktree, '.progress.json'), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Atomic write to .progress.json (tmp + rename). Default path: <worktree>/.progress.json
 */
export function writeProgress(worktree, report) {
    const file = path.join(worktree, '.progress.json');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(report, null, 2), 'utf-8');
    fs.renameSync(tmpFile, file);
}
/**
 * Read .phase-bridge.json. Default path: <worktree | cwd>/.phase-bridge.json
 */
export function readPhaseBridge(worktree) {
    const file = path.join(worktree ?? '.', '.phase-bridge.json');
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=process-io.js.map