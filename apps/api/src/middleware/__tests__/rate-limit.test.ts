/**
 * Rate limit middleware unit tests
 *
 * Verifies:
 * - authRateLimit: windowMs=60s, max=10, IP-level
 * - refreshRateLimit: windowMs=60s, max=20, IP-level
 * - Config consistency across all rate limiters
 */

import { describe, it, expect, vi } from 'vitest';

const { mockRateLimit } = vi.hoisted(() => {
  const createHandler = () => {
    const handler: any = () => {};
    handler.resetKey = vi.fn();
    handler.getKey = vi.fn();
    return handler as (...args: any[]) => any;
  };
  return { mockRateLimit: vi.fn(createHandler) };
});

vi.mock('express-rate-limit', () => ({
  default: mockRateLimit,
}));

// Import after mock — module top-level code calls mockRateLimit() during evaluation
import { authRateLimit, refreshRateLimit, mcpRateLimit, apiRateLimit } from '../rate-limit.js';

// Call order in rate-limit.ts: mcpRateLimit, apiRateLimit, authRateLimit, refreshRateLimit
const authConfig = mockRateLimit.mock.calls[2][0];
const refreshConfig = mockRateLimit.mock.calls[3][0];
const allConfigs = mockRateLimit.mock.calls.map((c) => c[0]);

describe('authRateLimit', () => {
  it('windowMs=60000 (60s)', () => {
    expect(authConfig.windowMs).toBe(60000);
  });

  it('max=10', () => {
    expect(authConfig.max).toBe(10);
  });

  it('uses IP-level limiting (no custom keyGenerator)', () => {
    expect(authConfig.keyGenerator).toBeUndefined();
  });
});

describe('refreshRateLimit', () => {
  it('windowMs=60000 (60s)', () => {
    expect(refreshConfig.windowMs).toBe(60000);
  });

  it('max=20', () => {
    expect(refreshConfig.max).toBe(20);
  });

  it('uses IP-level limiting (no custom keyGenerator)', () => {
    expect(refreshConfig.keyGenerator).toBeUndefined();
  });
});

describe('consistency with express-rate-limit style', () => {
  it('all rate limiters have standardHeaders=true', () => {
    allConfigs.forEach((c) => expect(c.standardHeaders).toBe(true));
  });

  it('all rate limiters have legacyHeaders=false', () => {
    allConfigs.forEach((c) => expect(c.legacyHeaders).toBe(false));
  });

  it('all rate limiters have windowMs=60000', () => {
    allConfigs.forEach((c) => expect(c.windowMs).toBe(60000));
  });

  it('all rate limiters use default IP-based keyGenerator', () => {
    allConfigs.forEach((c) => expect(c.keyGenerator).toBeUndefined());
  });

  it('all rate limiters have message.error defined', () => {
    allConfigs.forEach((c) => expect(c.message?.error).toBeDefined());
  });
});

it('exports are middleware functions', () => {
  expect(typeof authRateLimit).toBe('function');
  expect(typeof refreshRateLimit).toBe('function');
  expect(typeof mcpRateLimit).toBe('function');
  expect(typeof apiRateLimit).toBe('function');
});
