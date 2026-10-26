import { describe, expect, it } from 'vitest';
import {
  clearAgentServiceIdentitiesForTesting,
  issueAgentServiceIdentity,
  verifyAgentServiceIdentity,
  verifyAgentBrokerMarker,
  activeAgentServiceIdentityCountForTesting,
} from '../agent-identity';

describe('Agent service identity', () => {
  it('issues an execution-scoped expiring credential, never an Operator session', () => {
    clearAgentServiceIdentitiesForTesting();
    const identity = issueAgentServiceIdentity({ executionId: 'exec-sec05', ttlMs: 1_000, now: 10_000 });
    expect(identity.token).toMatch(/^sta_/);
    expect(identity.brokerMarker).toMatch(/^sab_/);
    expect(identity.brokerMarker).not.toBe(identity.token);
    expect(activeAgentServiceIdentityCountForTesting()).toBe(1);
    expect(verifyAgentBrokerMarker(identity.brokerMarker, 10_500)).toEqual({ executionId: 'exec-sec05' });
    expect(verifyAgentBrokerMarker(identity.token, 10_500)).toBeNull();
    expect(verifyAgentServiceIdentity(identity.token, 10_500)).toEqual({ executionId: 'exec-sec05' });
    expect(verifyAgentServiceIdentity(identity.token, 11_000)).toBeNull();
    expect(verifyAgentBrokerMarker(identity.brokerMarker, 11_000)).toBeNull();
    expect(verifyAgentServiceIdentity('not-an-agent-token', 10_500)).toBeNull();
    clearAgentServiceIdentitiesForTesting();
    expect(activeAgentServiceIdentityCountForTesting()).toBe(0);
  });
});
