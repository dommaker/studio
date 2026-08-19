/**
 * Compression filter unit tests (#263)
 *
 * Verifies:
 * - text/event-stream (SSE) responses are NOT compressed — global compression
 *   buffers SSE streams (#259 root cause), so the filter must exclude them
 * - application/json / text/html responses still go through default compressible logic
 */

import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { shouldCompress } from '../compression-filter.js';

function mockRes(contentType: string | undefined): Response {
  return {
    getHeader: (name: string) => (name === 'Content-Type' ? contentType : undefined),
  } as unknown as Response;
}

const req = {} as Request;

describe('shouldCompress', () => {
  it('returns false for text/event-stream', () => {
    expect(shouldCompress(req, mockRes('text/event-stream'))).toBe(false);
  });

  it('returns false for text/event-stream with charset parameter', () => {
    expect(shouldCompress(req, mockRes('text/event-stream; charset=utf-8'))).toBe(false);
  });

  it('returns true for application/json (default compression applies)', () => {
    expect(shouldCompress(req, mockRes('application/json'))).toBe(true);
  });

  it('returns true for application/json with charset parameter', () => {
    expect(shouldCompress(req, mockRes('application/json; charset=utf-8'))).toBe(true);
  });

  it('returns true for text/html (default compression applies)', () => {
    expect(shouldCompress(req, mockRes('text/html'))).toBe(true);
  });

  it('returns false for non-compressible types like image/png', () => {
    expect(shouldCompress(req, mockRes('image/png'))).toBe(false);
  });

  it('returns false when Content-Type header is absent', () => {
    expect(shouldCompress(req, mockRes(undefined))).toBe(false);
  });
});
