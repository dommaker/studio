/**
 * WebSocket Gateway — AS-020 P4: Daemon persistent connection
 * Path: /ws/daemon | Auth: first message | Ping/pong: 30s, 3 missed → offline
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import crypto from 'crypto';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

// ── Types ──

type ClientMessage =
  | { type: 'auth'; workspaceId: string; token: string }
  | { type: 'pong' }
  | { type: 'discover_response'; requestId: string; entries: DiscoverEntry[]; error?: string };

export interface DiscoverEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
}

export interface WsGatewayOptions {
  pingIntervalMs?: number;
  authTimeoutMs?: number;
  maxMissedPongs?: number;
}

interface ConnectionEntry {
  ws: WebSocket;
  workspaceId: string;
  authenticated: boolean;
  missedPongs: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  authTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingDiscover {
  resolve: (entries: DiscoverEntry[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Singleton state ──

const activeConnections = new Map<string, ConnectionEntry>();
const pendingDiscovers = new Map<string, PendingDiscover>();

// ── Token verification (shared with workspaceAuth middleware) ──

async function verifyWorkspaceToken(
  workspaceId: string,
  token: string,
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const workspaceToken = await prisma.workspaceToken.findUnique({
      where: { tokenHash },
      include: { workspaces: true },
    });

    if (!workspaceToken) {
      return { valid: false, reason: 'Invalid workspace token' };
    }

    if (workspaceToken.revokedAt) {
      return { valid: false, reason: 'Workspace token has been revoked' };
    }

    const workspace = workspaceToken.workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      return { valid: false, reason: 'Workspace not found for this token' };
    }

    return { valid: true };
  } catch (err) {
    logger.error({ err }, '[WsGateway] Token verification error');
    return { valid: false, reason: 'Token verification failed' };
  }
}

// ── Heartbeat update ──

async function updateHeartbeat(workspaceId: string, status: string): Promise<void> {
  try {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { status, lastHeartbeat: new Date() },
    });
  } catch (err) {
    logger.warn({ err, workspaceId }, '[WsGateway] Failed to update heartbeat');
  }
}

// ── Connection lifecycle ──

function cleanupConnection(entry: ConnectionEntry): void {
  if (entry.pingTimer) {
    clearInterval(entry.pingTimer);
    entry.pingTimer = null;
  }
  if (entry.authTimer) {
    clearTimeout(entry.authTimer);
    entry.authTimer = null;
  }
  activeConnections.delete(entry.workspaceId);

  // Mark workspace offline in DB
  if (entry.authenticated) {
    updateHeartbeat(entry.workspaceId, 'offline').catch(() => {});
    logger.info({ workspaceId: entry.workspaceId }, '[WsGateway] Disconnected, marked offline');
  }
}

function setupPingPong(entry: ConnectionEntry, opts: Required<WsGatewayOptions>): void {
  entry.pingTimer = setInterval(() => {
    if (entry.ws.readyState !== WebSocket.OPEN) return;
    if (!entry.authenticated) return; // Don't ping before auth

    if (entry.missedPongs >= opts.maxMissedPongs) {
      logger.info(
        { workspaceId: entry.workspaceId, missedPongs: entry.missedPongs },
        '[WsGateway] Too many missed pongs, closing',
      );
      entry.ws.close(4000, 'Heartbeat timeout');
      return;
    }

    entry.missedPongs++;
    entry.ws.send(JSON.stringify({ type: 'ping' }));
  }, opts.pingIntervalMs);
}

function handleMessage(entry: ConnectionEntry, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    logger.warn('[WsGateway] Invalid JSON message');
    return;
  }

  switch (msg.type) {
    case 'pong':
      entry.missedPongs = 0;
      // Also update heartbeat in DB on pong
      if (entry.authenticated) {
        updateHeartbeat(entry.workspaceId, 'idle').catch(() => {});
      }
      break;

    case 'discover_response': {
      const pending = pendingDiscovers.get(msg.requestId);
      if (!pending) break;
      clearTimeout(pending.timer);
      pendingDiscovers.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.entries || []);
      }
      break;
    }

    default:
      logger.warn({ type: (msg as { type: string }).type }, '[WsGateway] Unknown message type');
  }
}

async function handleAuth(entry: ConnectionEntry, msg: { workspaceId: string; token: string }): Promise<void> {
  const { workspaceId, token } = msg;

  if (!workspaceId || !token) {
    entry.ws.send(JSON.stringify({ type: 'auth_error', error: 'Missing workspaceId or token' }));
    entry.ws.close(4001, 'Missing credentials');
    return;
  }

  // Check if workspace already has an active connection
  const existing = activeConnections.get(workspaceId);
  if (existing && existing.ws !== entry.ws) {
    logger.info({ workspaceId }, '[WsGateway] Replacing existing connection');
    existing.ws.close(4002, 'Replaced by new connection');
    cleanupConnection(existing);
  }

  const result = await verifyWorkspaceToken(workspaceId, token);
  if (!result.valid) {
    entry.ws.send(JSON.stringify({ type: 'auth_error', error: result.reason }));
    entry.ws.close(4003, result.reason);
    return;
  }

  // Authenticated
  if (entry.authTimer) {
    clearTimeout(entry.authTimer);
    entry.authTimer = null;
  }

  entry.authenticated = true;
  entry.workspaceId = workspaceId;
  activeConnections.set(workspaceId, entry);

  await updateHeartbeat(workspaceId, 'idle');

  entry.ws.send(JSON.stringify({ type: 'auth_ok', workspaceId }));

  logger.info({ workspaceId }, '[WsGateway] Authenticated');
}

// ── Public API ──

/**
 * Attach WS gateway to an HTTP server.
 * Returns a cleanup function to detach and close all connections.
 */
export function attachWsGateway(
  server: HttpServer,
  options?: WsGatewayOptions,
): () => void {
  const opts: Required<WsGatewayOptions> = {
    pingIntervalMs: options?.pingIntervalMs ?? 30_000,
    authTimeoutMs: options?.authTimeoutMs ?? 10_000,
    maxMissedPongs: options?.maxMissedPongs ?? 3,
  };

  const wss = new WebSocketServer({ noServer: true });

  const upgradeHandler = (req: IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    // Only handle /ws/daemon path
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws/daemon') {
      return; // Not our path, let other handlers deal with it
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry: ConnectionEntry = {
        ws,
        workspaceId: '',
        authenticated: false,
        missedPongs: 0,
        pingTimer: null,
        authTimer: null,
      };

      // Auth timeout: close if no auth message within timeout
      entry.authTimer = setTimeout(() => {
        if (!entry.authenticated) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Auth timeout' }));
          ws.close(4004, 'Auth timeout');
        }
      }, opts.authTimeoutMs);

      ws.on('message', (data) => {
        const raw = typeof data === 'string' ? data : data.toString();

        // First message must be auth
        if (!entry.authenticated) {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'auth') {
              handleAuth(entry, msg).catch((err) => {
                logger.error({ err }, '[WsGateway] Auth handler error');
                ws.close(4005, 'Internal error');
              });
              return;
            }
          } catch {
            // Invalid JSON before auth
          }
          ws.send(JSON.stringify({ type: 'auth_error', error: 'First message must be auth' }));
          ws.close(4006, 'Auth required');
          return;
        }

        handleMessage(entry, raw);
      });

      ws.on('close', () => {
        cleanupConnection(entry);
      });

      ws.on('error', (err) => {
        logger.warn({ err }, '[WsGateway] WebSocket error');
      });

      // Setup ping/pong immediately (will only send pings after auth)
      setupPingPong(entry, opts);
    });
  };

  server.on('upgrade', upgradeHandler);

  // Cleanup function
  return () => {
    server.off('upgrade', upgradeHandler);
    for (const [, entry] of activeConnections) {
      entry.ws.close(1001, 'Server shutting down');
      cleanupConnection(entry);
    }
    // Reject all pending discovers
    for (const [, pending] of pendingDiscovers) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
    }
    pendingDiscovers.clear();
  };
}

/**
 * Send a message to a connected workspace Daemon.
 * Returns true if message was sent, false if no active connection.
 */
export function sendToWorkspace(workspaceId: string, message: unknown): boolean {
  const entry = activeConnections.get(workspaceId);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  entry.ws.send(JSON.stringify(message));
  return true;
}

/**
 * Check if a workspace has an active WS connection.
 */
export function isWorkspaceConnected(workspaceId: string): boolean {
  const entry = activeConnections.get(workspaceId);
  return !!entry && entry.ws.readyState === WebSocket.OPEN && entry.authenticated;
}

/**
 * Get all connected workspace IDs.
 */
export function getConnectedWorkspaceIds(): string[] {
  return [...activeConnections.entries()]
    .filter(([, entry]) => entry.authenticated && entry.ws.readyState === WebSocket.OPEN)
    .map(([id]) => id);
}

/**
 * Send discover request through WS and wait for response.
 * Throws on timeout or if no connection.
 */
export function discoverViaWs(
  workspaceId: string,
  path: string,
  timeoutMs = 10_000,
): Promise<DiscoverEntry[]> {
  return new Promise((resolve, reject) => {
    const entry = activeConnections.get(workspaceId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN || !entry.authenticated) {
      reject(new Error('No active connection for workspace'));
      return;
    }

    const requestId = crypto.randomUUID();

    const timer = setTimeout(() => {
      pendingDiscovers.delete(requestId);
      reject(new Error('Discover request timed out'));
    }, timeoutMs);

    pendingDiscovers.set(requestId, { resolve, reject, timer });

    entry.ws.send(JSON.stringify({
      type: 'discover_request',
      requestId,
      path,
    }));
  });
}

/**
 * Notify workspace that a task is available.
 * Returns true if notification was sent.
 */
export function notifyTaskAvailable(workspaceId: string, taskId: string): boolean {
  return sendToWorkspace(workspaceId, {
    type: 'task:available',
    taskId,
  });
}

/**
 * Get count of active connections (for health checks).
 */
export function getActiveConnectionCount(): number {
  return [...activeConnections.values()]
    .filter(e => e.authenticated && e.ws.readyState === WebSocket.OPEN).length;
}

// Expose internals for testing
export { activeConnections, pendingDiscovers };
