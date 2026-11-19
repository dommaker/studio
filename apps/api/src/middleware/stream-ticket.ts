import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const STREAM_TICKET_TTL_MS = 60_000;
const SSE_RESOURCE = '/api/v1/events/stream';
const ATTACHMENT_RESOURCE = /^\/api\/v1\/channels\/[^/]+\/attachments\/[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp)$/i;

interface StreamTicket {
  sessionId: string;
  resource: string;
  expiresAt: number;
}

const tickets = new Map<string, StreamTicket>();

function hashTicket(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isStreamResource(resource: string): boolean {
  return resource === SSE_RESOURCE || ATTACHMENT_RESOURCE.test(resource);
}

export function issueStreamTicket(input: { sessionId: string; resource: string; now?: number }): string {
  if (!isStreamResource(input.resource)) throw new Error('Stream tickets are limited to SSE and attachment GET resources');
  const now = input.now ?? Date.now();
  for (const [hash, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(hash);
  }
  const token = randomBytes(32).toString('base64url');
  tickets.set(hashTicket(token), {
    sessionId: input.sessionId,
    resource: input.resource,
    expiresAt: now + STREAM_TICKET_TTL_MS,
  });
  return token;
}

/** Consume before authentication so every failed cross-resource or replay attempt has no stream side effects. */
export function consumeStreamTicket(token: string, resource: string, now = Date.now()): string | null {
  const hash = hashTicket(token);
  const ticket = tickets.get(hash);
  if (!ticket) return null;
  tickets.delete(hash);
  if (ticket.expiresAt <= now || ticket.resource !== resource) return null;
  return ticket.sessionId;
}

function requestResource(req: Request): string | null {
  if (req.method !== 'GET') return null;
  const resource = req.originalUrl.split('?', 1)[0];
  return isStreamResource(resource) ? resource : null;
}

/** Query credentials are recognized only here; all other routes ignore them. */
export function streamTicketAuth(req: Request, res: Response, next: NextFunction): void {
  const resource = requestResource(req);
  if (!resource) return next();
  const token = req.query.token;
  if (token === undefined) return next();
  const sessionId = typeof token === 'string' ? consumeStreamTicket(token, resource) : null;
  if (!sessionId) {
    res.status(401).json({ error: { code: 'INVALID_STREAM_TICKET', message: 'A valid single-use stream ticket is required' } });
    return;
  }
  req.streamSessionId = sessionId;
  next();
}

export function resetStreamTicketsForTesting(): void {
  tickets.clear();
}
