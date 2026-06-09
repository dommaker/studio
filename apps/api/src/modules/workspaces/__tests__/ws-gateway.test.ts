/**
 * WS Gateway tests — AS-020 P4
 *
 * Covers:
 *   - Auth flow (valid token, invalid token, revoked token, timeout)
 *   - Ping/pong heartbeat
 *   - Connection cleanup on close
 *   - Discover proxy (request/response, timeout, no connection)
 *   - Multiple connections (replacement)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import WebSocket from 'ws';
import crypto from 'crypto';
import { prisma } from '../../../core/database.js';
import {
  attachWsGateway,
  isWorkspaceConnected,
  getConnectedWorkspaceIds,
  sendToWorkspace,
  discoverViaWs,
  notifyTaskAvailable,
  getActiveConnectionCount,
  activeConnections,
} from '../ws-gateway.js';

// ── Helpers ──

function generateToken(): string {
  return `st_mach_${crypto.randomBytes(24).toString('base64url')}`;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch { /* ignore invalid JSON */ }
    };
    ws.on('message', handler);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

// ── Test setup ──

let server: HttpServer;
let serverPort: number;
let cleanup: () => void;
let testTokenId: string;
let testWorkspaceId: string;
let testTokenPlaintext: string;

beforeAll(async () => {
  // Create test token + workspace in DB
  testTokenPlaintext = generateToken();
  const tokenHash = hashToken(testTokenPlaintext);

  const token = await prisma.workspaceToken.create({
    data: {
      name: 'ws-gateway-test-token',
      tokenHash,
      permissions: JSON.stringify(['execute']),
    },
  });
  testTokenId = token.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: 'ws-gateway-test-workspace',
      tokenId: testTokenId,
      workspaceRoot: '/tmp/ws-test',
      status: 'offline',
    },
  });
  testWorkspaceId = workspace.id;

  // Create HTTP server + attach WS gateway
  server = createServer();
  cleanup = attachWsGateway(server, {
    pingIntervalMs: 500,    // Fast for tests
    authTimeoutMs: 2000,    // 2s auth timeout for tests
    maxMissedPongs: 2,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (cleanup) cleanup();
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2000); // Fallback
    });
  }

  // Cleanup DB
  if (testWorkspaceId) {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId: testWorkspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId: testWorkspaceId } });
    await prisma.workspaceRuntime.deleteMany({ where: { workspaceId: testWorkspaceId } });
    await prisma.workspace.deleteMany({ where: { id: testWorkspaceId } });
  }
  if (testTokenId) {
    await prisma.workspaceToken.deleteMany({ where: { id: testTokenId } });
  }
});

afterEach(() => {
  // Ensure no dangling connections
  for (const [, entry] of activeConnections) {
    try { entry.ws.close(); } catch {}
  }
});

// ── Tests ──

describe('WS Gateway Auth', () => {
  it('authenticates with valid token', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));

    const msg = await waitForMessage(ws, 'auth_ok') as { type: string; workspaceId: string };
    expect(msg.type).toBe('auth_ok');
    expect(msg.workspaceId).toBe(testWorkspaceId);
    expect(isWorkspaceConnected(testWorkspaceId)).toBe(true);

    ws.close();
    // Wait for close to propagate
    await new Promise(r => setTimeout(r, 100));
  });

  it('rejects invalid token', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: 'invalid-token',
    }));

    const msg = await waitForMessage(ws, 'auth_error') as { type: string; error: string };
    expect(msg.type).toBe('auth_error');
    expect(msg.error).toContain('Invalid workspace token');

    // WS should be closed by server
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects non-existent workspaceId', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: 'non-existent-id',
      token: testTokenPlaintext,
    }));

    const msg = await waitForMessage(ws, 'auth_error') as { type: string; error: string };
    expect(msg.type).toBe('auth_error');
    expect(msg.error).toContain('Workspace not found for this token');

    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects revoked token', async () => {
    // Create a revoked token
    const revokedPlaintext = generateToken();
    const revokedToken = await prisma.workspaceToken.create({
      data: {
        name: 'revoked-test',
        tokenHash: hashToken(revokedPlaintext),
        permissions: '["execute"]',
      },
    });
    await prisma.workspaceToken.update({
      where: { id: revokedToken.id },
      data: { revokedAt: new Date() },
    });

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: revokedPlaintext,
    }));

    const msg = await waitForMessage(ws, 'auth_error') as { type: string; error: string };
    expect(msg.type).toBe('auth_error');
    expect(msg.error).toContain('revoked');

    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.CLOSED);

    await prisma.workspaceToken.delete({ where: { id: revokedToken.id } });
  });

  it('rejects non-auth first message', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'pong' }));

    const msg = await waitForMessage(ws, 'auth_error') as { type: string; error: string };
    expect(msg.type).toBe('auth_error');
    expect(msg.error).toContain('First message must be auth');

    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects connection on auth timeout', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    // Don't send auth, wait for timeout (authTimeoutMs=2000 in test config)
    const msg = await waitForMessage(ws, 'auth_error', 5000) as { type: string; error: string };
    expect(msg.type).toBe('auth_error');
    expect(msg.error).toContain('Auth timeout');

    await new Promise(r => setTimeout(r, 300));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('WS Gateway Ping/Pong', () => {
  it('responds to ping with pong and maintains connection', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    // Auth first
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    // Wait for at least one ping (500ms interval in test config)
    const pingMsg = await waitForMessage(ws, 'ping', 2000) as { type: string };
    expect(pingMsg.type).toBe('ping');

    // Reply with pong
    ws.send(JSON.stringify({ type: 'pong' }));

    // Connection should stay alive
    await new Promise(r => setTimeout(r, 600));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('closes connection after max missed pongs', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    // Don't reply to pongs — should close after 2 missed pongs * 500ms = ~1s
    await new Promise(r => setTimeout(r, 2000));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('WS Gateway Connection Management', () => {
  it('replaces existing connection for same workspace', async () => {
    const ws1 = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws1, 'auth_ok');
    expect(isWorkspaceConnected(testWorkspaceId)).toBe(true);

    // Second connection for same workspace
    const ws2 = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws2, 'auth_ok');

    // First should be closed
    await new Promise(r => setTimeout(r, 200));
    expect(ws1.readyState).toBe(WebSocket.CLOSED);
    // Second should be active
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    expect(isWorkspaceConnected(testWorkspaceId)).toBe(true);

    ws2.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('cleans up on client disconnect', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');
    expect(isWorkspaceConnected(testWorkspaceId)).toBe(true);

    ws.close();
    await new Promise(r => setTimeout(r, 300));
    expect(isWorkspaceConnected(testWorkspaceId)).toBe(false);
  });

  it('sendToWorkspace returns false when not connected', () => {
    expect(sendToWorkspace('non-existent', { type: 'test' })).toBe(false);
  });

  it('sendToWorkspace returns true when connected', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    expect(sendToWorkspace(testWorkspaceId, { type: 'test' })).toBe(true);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('getConnectedWorkspaceIds returns connected ids', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    const ids = getConnectedWorkspaceIds();
    expect(ids).toContain(testWorkspaceId);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('getActiveConnectionCount returns correct count', async () => {
    const before = getActiveConnectionCount();

    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    expect(getActiveConnectionCount()).toBe(before + 1);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
    expect(getActiveConnectionCount()).toBe(before);
  });
});

describe('Discover Proxy', () => {
  it('discovers via WS and returns entries', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    // Setup listener on client side to respond to discover_request
    const mockEntries = [
      { name: 'src', type: 'directory' },
      { name: 'package.json', type: 'file', size: 1234 },
    ];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'discover_request') {
        ws.send(JSON.stringify({
          type: 'discover_response',
          requestId: msg.requestId,
          entries: mockEntries,
        }));
      }
    });

    const entries = await discoverViaWs(testWorkspaceId, '/tmp/ws-test');
    expect(entries).toEqual(mockEntries);

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('rejects discover when no connection', async () => {
    await expect(discoverViaWs('no-workspace', '/tmp')).rejects.toThrow('No active connection');
  });

  it('rejects discover on timeout', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    // Don't respond to discover request — should timeout
    await expect(discoverViaWs(testWorkspaceId, '/tmp', 500)).rejects.toThrow('timed out');

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('rejects discover on error response', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'discover_request') {
        ws.send(JSON.stringify({
          type: 'discover_response',
          requestId: msg.requestId,
          entries: [],
          error: 'Path not found',
        }));
      }
    });

    await expect(discoverViaWs(testWorkspaceId, '/nonexistent')).rejects.toThrow('Path not found');

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });
});

describe('Task Notification', () => {
  it('sends task:available to connected workspace', async () => {
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/daemon`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({
      type: 'auth',
      workspaceId: testWorkspaceId,
      token: testTokenPlaintext,
    }));
    await waitForMessage(ws, 'auth_ok');

    const taskMsg = waitForMessage(ws, 'task:available') as Promise<{ type: string; taskId: string }>;
    const result = notifyTaskAvailable(testWorkspaceId, 'task-123');
    expect(result).toBe(true);

    const msg = await taskMsg;
    expect(msg.type).toBe('task:available');
    expect(msg.taskId).toBe('task-123');

    ws.close();
    await new Promise(r => setTimeout(r, 100));
  });

  it('returns false when workspace not connected', () => {
    expect(notifyTaskAvailable('non-existent', 'task-123')).toBe(false);
  });
});

describe('Non-daemon paths', () => {
  it('ignores upgrade for other paths', async () => {
    // This should not be handled by the WS gateway — no upgrade, connection refused
    const ws = new WebSocket(`ws://localhost:${serverPort}/ws/other`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve()); // Expected: no upgrade handler → error
      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 1000);
    });
    // If we get here without crashing, the test passes
  });
});
