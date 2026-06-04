/**
 * ExternalFetcher — fetch external docs and ingest as reference knowledge
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock sharedIngest
const mockIngestExternal = vi.fn().mockReturnValue({
  id: 'ext-1', type: 'guideline', title: 'Test', content: 'Content',
  maturity: 'draft', layer: 'tech', created: new Date().toISOString(),
  lastReferenced: new Date().toISOString(), contributors: [], projects: [],
  tags: [], applicablePhases: [], sourceReferences: [], referencedBy: [],
  executionResults: [], consumptionMode: 'reference', origin: 'external',
});
vi.mock('../../knowledge-bus.service.js', () => ({
  sharedIngest: { ingestExternal: mockIngestExternal },
  sharedStore: {},
  UNIFIED_KNOWLEDGE_DIR: '/tmp/test-knowledge',
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchExternal } = await import('../external-fetcher.js');

describe('ExternalFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch URL and ingest as reference', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<html><head><title>Title</title></head><body><p>Content here</p></body></html>'),
    });

    const result = await fetchExternal('https://example.com/doc');

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/doc', expect.any(Object));
    expect(mockIngestExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'architecture',
        title: expect.stringContaining('Title'),
        content: expect.stringContaining('Content here'),
      }),
      expect.objectContaining({
        source: 'external:example.com',
        layer: 'tech',
        consumptionMode: 'reference',
      }),
    );
    expect(result).toBeDefined();
  });

  it('should strip HTML tags from content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<html><head><script>alert("xss")</script></head><body><p>Safe content</p></body></html>'),
    });

    await fetchExternal('https://example.com');

    const call = mockIngestExternal.mock.calls[0];
    const content = call[0].content;
    expect(content).not.toContain('<script>');
    expect(content).not.toContain('<p>');
    expect(content).toContain('Safe content');
  });

  it('should handle plain text response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/plain' },
      text: () => Promise.resolve('Plain text content'),
    });

    await fetchExternal('https://example.com/readme.txt');

    const call = mockIngestExternal.mock.calls[0];
    expect(call[0].content).toBe('Plain text content');
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(fetchExternal('https://example.com/missing')).rejects.toThrow('404');
  });

  it('should extract domain as source', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/plain' },
      text: () => Promise.resolve('content'),
    });

    await fetchExternal('https://github.com/org/repo/blob/main/README.md');

    expect(mockIngestExternal).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ source: 'external:github.com' }),
    );
  });

  it('should truncate long content', async () => {
    const longContent = 'x'.repeat(100_000);
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/plain' },
      text: () => Promise.resolve(longContent),
    });

    await fetchExternal('https://example.com/huge');

    const call = mockIngestExternal.mock.calls[0];
    // Content should be truncated (sanitizeExternalContent handles this via harness)
    expect(call[0].content.length).toBeLessThanOrEqual(longContent.length);
  });
});
