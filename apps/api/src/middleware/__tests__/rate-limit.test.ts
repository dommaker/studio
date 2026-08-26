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

describe('loopback skip（2026-08-25 收口）', () => {
  // Call order in rate-limit.ts: mcpRateLimit, apiRateLimit, authRateLimit, refreshRateLimit
  const mcpConfig = mockRateLimit.mock.calls[0][0];
  const apiConfig = mockRateLimit.mock.calls[1][0];

  it('mcpRateLimit / apiRateLimit 挂 skip（回环直连不限频）', () => {
    expect(typeof mcpConfig.skip).toBe('function');
    expect(typeof apiConfig.skip).toBe('function');
  });

  it('authRateLimit / refreshRateLimit 不挂 skip（认证端点一律限频）', () => {
    expect(authConfig.skip).toBeUndefined();
    expect(refreshConfig.skip).toBeUndefined();
  });

  it('skipLoopback 判定：回环三种写法 skip，公网 IP 不 skip', () => {
    const skip = apiConfig.skip;
    expect(skip({ ip: '127.0.0.1' })).toBe(true);
    expect(skip({ ip: '::1' })).toBe(true);
    expect(skip({ ip: '::ffff:127.0.0.1' })).toBe(true);
    expect(skip({ ip: '203.0.113.9' })).toBe(false);
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
