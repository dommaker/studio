import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { routeHandler } = vi.hoisted(() => ({
  routeHandler: { value: null as ((...args: unknown[]) => unknown) | null },
}));

vi.mock('express', () => {
  const Router = vi.fn(() => {
    const r: Record<string, unknown> = {
      get: vi.fn((...args: unknown[]) => {
        routeHandler.value = args[args.length - 1] as (...args: unknown[]) => unknown;
        return r;
      }),
      stack: [] as unknown[],
    };
    return r;
  });
  return { Router, default: { Router } };
});

vi.mock('@dommaker/harness', () => ({
  checkConstraints: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import '../docs-freshness.routes.js';

function mockReqRes() {
  const req = {} as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('GET /', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('harnessCheck.details includes capability_sync entry', async () => {
    const { checkConstraints } = await import('@dommaker/harness');
    (checkConstraints as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: true,
      warningCount: 0,
      guidelines: [
        { id: 'capability_sync', satisfied: true, message: 'CAPABILITIES.md is in sync' },
        { id: 'docs_freshness', satisfied: true, message: 'Docs are fresh' },
      ],
      ironLaws: [],
    });

    const { req, res } = mockReqRes();
    await routeHandler.value!(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessCheck: expect.objectContaining({
          details: expect.arrayContaining([
            expect.objectContaining({ id: 'capability_sync' }),
          ]),
        }),
      }),
    );
  });

  it('capability_sync passed reflects mock satisfied value', async () => {
    const { checkConstraints } = await import('@dommaker/harness');
    const mockCheckConstraints = checkConstraints as ReturnType<typeof vi.fn>;

    // Test: satisfied=true => passed=true
    mockCheckConstraints.mockResolvedValue({
      passed: true,
      warningCount: 0,
      guidelines: [
        { id: 'capability_sync', satisfied: true, message: 'In sync' },
        { id: 'docs_freshness', satisfied: true, message: 'Fresh' },
      ],
      ironLaws: [],
    });

    const { req: req1, res: res1 } = mockReqRes();
    await routeHandler.value!(req1, res1);
    const jsonArg1 = (res1.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const cs1 = jsonArg1.harnessCheck.details.find((d: { id: string }) => d.id === 'capability_sync');
    expect(cs1.passed).toBe(true);

    // Test: satisfied=false => passed=false
    vi.clearAllMocks();
    mockCheckConstraints.mockResolvedValue({
      passed: false,
      warningCount: 1,
      guidelines: [
        { id: 'capability_sync', satisfied: false, message: 'Out of sync' },
        { id: 'docs_freshness', satisfied: true, message: 'Fresh' },
      ],
      ironLaws: [],
    });

    const { req: req2, res: res2 } = mockReqRes();
    await routeHandler.value!(req2, res2);
    const jsonArg2 = (res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const cs2 = jsonArg2.harnessCheck.details.find((d: { id: string }) => d.id === 'capability_sync');
    expect(cs2.passed).toBe(false);
  });
});
