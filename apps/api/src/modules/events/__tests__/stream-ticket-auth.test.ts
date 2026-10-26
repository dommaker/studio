import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../../core/store.js';
import { issueStreamTicket, resetStreamTicketsForTesting, streamTicketAuth } from '../../../middleware/stream-ticket.js';
import { optionalAuth, requireAuth } from '../../../middleware/auth.js';
import { JWT_SECRET } from '../../auth/service.js';
import sseRoutes from '../sse.routes.js';

const SSE_RESOURCE = '/api/v1/events/stream';
const OTHER_RESOURCE = '/api/v1/channels/ch-a/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
const usersFile = path.join(studioDir(), 'users.json');
const sessionsFile = path.join(studioDir(), 'sessions.json');
const expiry = () => new Date(Date.now() + 60_000).toISOString();

describe('SSE stream ticket HTTP authentication', () => {
  let server: Server;
  let base: string;
  let operatorJwt: string;
  let pmoSideEffects = 0;

  beforeAll(async () => {
    process.env.STUDIO_AUTH = 'on';
    operatorJwt = jwt.sign({ sid: 'operator-session', uid: 'operator-1' }, JWT_SECRET);
    const app = express();
    app.use(express.json());
    app.use('/api/v1', streamTicketAuth, optionalAuth());
    app.use('/api/v1/events', requireAuth(), sseRoutes);
    app.post('/api/v1/pmo/project/:id/deliver', requireAuth(), (_req, res) => {
      pmoSideEffects += 1;
      res.json({ data: { delivered: true } });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    resetStreamTicketsForTesting();
    pmoSideEffects = 0;
    await getStore().writeJson(usersFile, [{
      id: 'operator-1', email: 'owner@example.test', passwordHash: 'not-projected', name: 'Owner', avatar: null,
      role: 'Admin', emailVerified: null, createdAt: expiry(), updatedAt: expiry(),
    }]);
    await getStore().writeJson(sessionsFile, [{
      id: 'operator-session', userId: 'operator-1', token: operatorJwt, guestId: null,
      ipAddress: null, userAgent: null, expiresAt: expiry(), createdAt: expiry(), refreshToken: null,
    }]);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.STUDIO_AUTH = 'none';
  });

  async function clientCount(): Promise<number> {
    const res = await fetch(`${base}/api/v1/events/clients`, { headers: { Authorization: `Bearer ${operatorJwt}` } });
    expect(res.status).toBe(200);
    return (await res.json()).total;
  }

  it('valid EventSource ticket opens a stream; replay and long JWT query fail without a new client', async () => {
    const before = await clientCount();
    const ticket = issueStreamTicket({ sessionId: 'operator-session', resource: SSE_RESOURCE });
    const controller = new AbortController();
    const stream = await fetch(`${base}${SSE_RESOURCE}?token=${encodeURIComponent(ticket)}`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const first = await stream.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('clientId');

    expect((await fetch(`${base}${SSE_RESOURCE}?token=${encodeURIComponent(ticket)}`)).status).toBe(401);
    expect((await fetch(`${base}${SSE_RESOURCE}?token=${encodeURIComponent(operatorJwt)}`)).status).toBe(401);
    expect(await clientCount()).toBe(before + 1);
    controller.abort();
  });

  it('expired and cross-resource tickets fail before any stream handler side effect', async () => {
    const before = await clientCount();
    const expired = issueStreamTicket({ sessionId: 'operator-session', resource: SSE_RESOURCE, now: Date.now() - 61_000 });
    const cross = issueStreamTicket({ sessionId: 'operator-session', resource: OTHER_RESOURCE });
    expect((await fetch(`${base}${SSE_RESOURCE}?token=${expired}`)).status).toBe(401);
    expect((await fetch(`${base}${SSE_RESOURCE}?token=${cross}`)).status).toBe(401);
    expect(await clientCount()).toBe(before);
  });

  it('ordinary PMO URL query token is not authentication and has zero delivery side effects', async () => {
    const ticket = issueStreamTicket({ sessionId: 'operator-session', resource: SSE_RESOURCE });
    for (const token of [operatorJwt, ticket]) {
      const res = await fetch(`${base}/api/v1/pmo/project/p1/deliver?token=${encodeURIComponent(token)}`, { method: 'POST' });
      expect(res.status).toBe(401);
    }
    expect(pmoSideEffects).toBe(0);
  });
});
