import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  consumeStreamTicket,
  issueStreamTicket,
  resetStreamTicketsForTesting,
  streamTicketAuth,
} from '../stream-ticket.js';

const SSE = '/api/v1/events/stream';
const ATTACHMENT_A = '/api/v1/channels/ch-a/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
const ATTACHMENT_B = '/api/v1/channels/ch-b/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
const NOW = Date.parse('2026-10-27T00:00:00.000Z');

beforeEach(() => resetStreamTicketsForTesting());

describe('resource-bound stream tickets', () => {
  it('authenticates one SSE connection once, then rejects replay', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: SSE, now: NOW });
    expect(consumeStreamTicket(ticket, SSE, NOW + 1)).toBe('session-1');
    expect(consumeStreamTicket(ticket, SSE, NOW + 2)).toBeNull();
  });

  it('binds an attachment ticket to the exact resource and consumes it on a cross-resource attempt', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: ATTACHMENT_A, now: NOW });
    expect(consumeStreamTicket(ticket, ATTACHMENT_B, NOW + 1)).toBeNull();
    expect(consumeStreamTicket(ticket, ATTACHMENT_A, NOW + 1)).toBeNull();
  });

  it('rejects expired tickets and long-lived credentials', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: SSE, now: NOW });
    expect(consumeStreamTicket(ticket, SSE, NOW + 61_000)).toBeNull();
    expect(consumeStreamTicket('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long-lived.signature', SSE, NOW)).toBeNull();
  });

  it('fails closed when issuing for an ordinary API resource', () => {
    expect(() => issueStreamTicket({ sessionId: 'session-1', resource: '/api/v1/pmo/projects', now: NOW })).toThrow();
  });
});

describe('streamTicketAuth', () => {
  function invoke(path: string, token?: string) {
    const req = {
      method: 'GET', path, originalUrl: `${path}${token ? `?token=${token}` : ''}`,
      query: token ? { token } : {}, headers: {},
    } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    streamTicketAuth(req, res, next);
    return { req, res, next };
  }

  it('projects a valid ticket into the internal session handoff without exposing credentials', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: SSE, now: Date.now() });
    const { req, next } = invoke(SSE, ticket);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.streamSessionId).toBe('session-1');
    expect(req.headers.authorization).toBeUndefined();
  });

  it('rejects invalid, replayed and cross-resource tickets without calling the stream handler', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: ATTACHMENT_A, now: Date.now() });
    const crossResource = invoke(ATTACHMENT_B, ticket);
    expect(crossResource.next).not.toHaveBeenCalled();
    expect(crossResource.res.status).toHaveBeenCalledWith(401);

    const replay = invoke(ATTACHMENT_A, ticket);
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.res.status).toHaveBeenCalledWith(401);
  });

  it('does not consume or recognize a query ticket on an ordinary PMO URL', () => {
    const ticket = issueStreamTicket({ sessionId: 'session-1', resource: SSE, now: Date.now() });
    const { req, next } = invoke('/api/v1/pmo/projects', ticket);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.streamSessionId).toBeUndefined();
    expect(consumeStreamTicket(ticket, SSE, Date.now())).toBe('session-1');
  });
});
