import { createHash, randomBytes } from 'node:crypto';

interface AgentServiceIdentityRecord {
  executionId: string;
  expiresAt: number;
  brokerMarkerHash: string;
}

const identities = new Map<string, AgentServiceIdentityRecord>();
const brokerMarkers = new Map<string, { executionId: string; expiresAt: number }>();
const TOKEN_PREFIX = 'sta_';
const BROKER_MARKER_PREFIX = 'sab_';

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Issue a memory-only, execution-scoped credential. It is not a JWT or Operator session. */
export function issueAgentServiceIdentity(opts: {
  executionId: string;
  ttlMs: number;
  now?: number;
}): { token: string; brokerMarker: string; expiresAt: number } {
  if (!opts.executionId || !Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new Error('Agent service identity requires executionId and positive ttlMs');
  }
  const now = opts.now ?? Date.now();
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const brokerMarker = BROKER_MARKER_PREFIX + randomBytes(32).toString('base64url');
  const brokerMarkerHash = digest(brokerMarker).toString('hex');
  const expiresAt = now + opts.ttlMs;
  identities.set(digest(token).toString('hex'), { executionId: opts.executionId, expiresAt, brokerMarkerHash });
  brokerMarkers.set(brokerMarkerHash, { executionId: opts.executionId, expiresAt });
  return { token, brokerMarker, expiresAt };
}

export function isAgentServiceToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function verifyAgentServiceIdentity(token: string, now = Date.now()): { executionId: string } | null {
  if (!isAgentServiceToken(token)) return null;
  const key = digest(token).toString('hex');
  const record = identities.get(key);
  if (!record) return null;
  if (record.expiresAt <= now) {
    identities.delete(key);
    brokerMarkers.delete(record.brokerMarkerHash);
    return null;
  }
  return { executionId: record.executionId };
}

export function verifyAgentBrokerMarker(marker: string, now = Date.now()): { executionId: string } | null {
  if (!marker.startsWith(BROKER_MARKER_PREFIX)) return null;
  const key = digest(marker).toString('hex');
  const record = brokerMarkers.get(key);
  if (!record) return null;
  if (record.expiresAt <= now) {
    brokerMarkers.delete(key);
    return null;
  }
  return { executionId: record.executionId };
}

export function revokeAgentServiceIdentity(token: string): void {
  if (!isAgentServiceToken(token)) return;
  const key = digest(token).toString('hex');
  const record = identities.get(key);
  identities.delete(key);
  if (record) brokerMarkers.delete(record.brokerMarkerHash);
}

export function clearAgentServiceIdentitiesForTesting(): void {
  identities.clear();
  brokerMarkers.clear();
}

export function activeAgentServiceIdentityCountForTesting(): number {
  return identities.size;
}
