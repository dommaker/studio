/**
 * Wiki routes — SDD migration tests
 *
 * Tests the SDD-based read logic:
 *   - listWikiDocs: scan SDD files + in-memory filter
 *   - buildWikiGraph: SDD-based graph nodes/edges
 *   - getWikiDocById: findSddDocById + read 3 layers
 *
 * All reads are SDD-only (no DB fallback).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mocks ──

const mockListSddDocs = vi.fn() as Mock;
const mockReadSddDoc = vi.fn() as Mock;
const mockFindSddDocById = vi.fn() as Mock;

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...orig,
    listSddDocs: (...args: unknown[]) => mockListSddDocs(...args),
    readSddDoc: (...args: unknown[]) => mockReadSddDoc(...args),
    findSddDocById: (...args: unknown[]) => mockFindSddDocById(...args),
  };
});

import {
  listWikiDocs,
  buildWikiGraph,
  getWikiDocById,
} from '../wiki.service.js';

// ── Fixtures ──

function makeReqMeta(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-001',
    slug: 'test-doc',
    title: 'Test Document',
    status: 'confirmed',
    tier: 'standard',
    version: 1,
    tags: ['test'],
    linkedDocIds: ['doc-002'],
    goalId: 'goal-001',
    sourceChannelId: 'ch-001',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// ── listWikiDocs ──

describe('listWikiDocs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SDD-based list with no filters', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed', updatedAt: '2026-06-01T00:00:00Z' }), body: 'body A' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', status: 'draft', updatedAt: '2026-05-01T00:00:00Z' }), body: 'body B' });

    const result = await listWikiDocs({});

    expect(result).toHaveLength(2);
    // Sorted by updatedAt desc — a1 is newer
    expect(result[0].id).toBe('a1');
    expect(result[1].id).toBe('b1');
    expect(mockListSddDocs).toHaveBeenCalled();
  });

  it('filters by status', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed' }), body: 'body A' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', status: 'draft' }), body: 'body B' });

    const result = await listWikiDocs({ status: 'confirmed' });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('confirmed');
  });

  it('filters by multiple statuses (comma-separated)', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b', 'doc-c']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed' }), body: '' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', status: 'draft' }), body: '' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'c1', slug: 'doc-c', title: 'Gamma', status: 'done' }), body: '' });

    const result = await listWikiDocs({ status: 'confirmed,done' });

    expect(result).toHaveLength(2);
    expect(result.map(d => d.id).sort()).toEqual(['a1', 'c1']);
  });

  it('filters by search (title match, case-insensitive)', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'JWT Auth', status: 'confirmed' }), body: 'body A' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'User Model', status: 'draft' }), body: 'body B' });

    const result = await listWikiDocs({ search: 'jwt' });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('JWT Auth');
  });

  it('filters by search (body match)', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed' }), body: 'contains JWT token auth' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', status: 'draft' }), body: 'no match here' });

    const result = await listWikiDocs({ search: 'JWT' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('returns results sorted by updatedAt desc', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', updatedAt: '2026-01-01T00:00:00Z' }), body: '' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', updatedAt: '2026-06-01T00:00:00Z' }), body: '' });

    const result = await listWikiDocs({});

    expect(result[0].id).toBe('b1'); // newer first
    expect(result[1].id).toBe('a1');
  });

  it('returns empty when SDD returns empty', async () => {
    mockListSddDocs.mockReturnValue([]);

    const result = await listWikiDocs({});

    expect(result).toHaveLength(0);
  });

  it('skips null results from readSddDoc', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-broken']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha' }), body: '' })
      .mockReturnValueOnce(null); // broken file

    const result = await listWikiDocs({});

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a1');
  });

  it('skips docs with missing id', async () => {
    mockListSddDocs.mockReturnValue(['doc-a']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: { title: 'No ID', slug: 'doc-a', status: 'draft' }, body: '' });

    const result = await listWikiDocs({});

    expect(result).toHaveLength(0);
  });
});

// ── buildWikiGraph ──

describe('buildWikiGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns nodes and edges from SDD', async () => {
    mockListSddDocs.mockReturnValue(['doc-a', 'doc-b']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed', linkedDocIds: ['b1'] }), body: '' })
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'b1', slug: 'doc-b', title: 'Beta', status: 'draft', linkedDocIds: [] }), body: '' });

    const result = await buildWikiGraph();

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ source: 'a1', target: 'b1' });
  });

  it('skips edges to non-existent nodes', async () => {
    mockListSddDocs.mockReturnValue(['doc-a']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed', linkedDocIds: ['nonexistent'] }), body: '' });

    const result = await buildWikiGraph();

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('handles missing linkedDocIds gracefully', async () => {
    mockListSddDocs.mockReturnValue(['doc-a']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed' }), body: '' });
    // linkedDocIds undefined in meta

    const result = await buildWikiGraph();

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('returns empty graph when SDD returns empty', async () => {
    mockListSddDocs.mockReturnValue([]);

    const result = await buildWikiGraph();

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('produces correct node shape', async () => {
    mockListSddDocs.mockReturnValue(['doc-a']);
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'a1', slug: 'doc-a', title: 'Alpha', status: 'confirmed' }), body: '' });

    const result = await buildWikiGraph();

    expect(result.nodes[0]).toEqual({ id: 'a1', name: 'Alpha', status: 'confirmed' });
  });
});

// ── getWikiDocById ──

describe('getWikiDocById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full doc with 3 layers from SDD', async () => {
    mockFindSddDocById.mockReturnValue('test-doc');
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'requirement body' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'design body' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'task body' });

    const result = await getWikiDocById('doc-001');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('doc-001');
    expect(result!.title).toBe('Test Document');
    expect(result!.requirement).toBe('requirement body');
    expect(result!.design).toBe('design body');
    expect(result!.task).toBe('task body');
    expect(mockFindSddDocById).toHaveBeenCalledWith('doc-001');
  });

  it('returns null when SDD not found', async () => {
    mockFindSddDocById.mockReturnValue(null);

    const result = await getWikiDocById('nonexistent');

    expect(result).toBeNull();
  });

  it('returns null when SDD not found (no DB fallback)', async () => {
    mockFindSddDocById.mockReturnValue(null);

    const result = await getWikiDocById('db-1');

    expect(result).toBeNull();
  });

  it('returns metadata from requirement frontmatter', async () => {
    mockFindSddDocById.mockReturnValue('test-doc');
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ tags: ['arch', 'api'], workUnitId: 'g-1', sourceChannelId: 'ch-1', tier: 'premium' }), body: 'req' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'design' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'task' });

    const result = await getWikiDocById('doc-001');

    expect(result!.tags).toEqual(['arch', 'api']);
    expect(result!.workUnitId).toBe('g-1');
    expect(result!.sourceChannelId).toBe('ch-1');
    expect(result!.tier).toBe('premium');
  });

  it('handles partial layers (only requirement exists)', async () => {
    mockFindSddDocById.mockReturnValue('test-doc');
    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'requirement body' })
      .mockReturnValueOnce(null) // no design
      .mockReturnValueOnce(null); // no task

    const result = await getWikiDocById('doc-001');

    expect(result).not.toBeNull();
    expect(result!.requirement).toBe('requirement body');
    expect(result!.design).toBeNull();
    expect(result!.task).toBeNull();
  });

  it('resolves linkedDocIds to linkedDocs with titles', async () => {
    mockFindSddDocById
      .mockReturnValueOnce('test-doc')      // main doc lookup
      .mockReturnValueOnce('linked-doc');    // linked doc lookup

    mockReadSddDoc
      .mockReturnValueOnce({ meta: makeReqMeta({ linkedDocIds: ['linked-id'] }), body: 'req' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'design' })
      .mockReturnValueOnce({ meta: makeReqMeta(), body: 'task' })
      // readSddDoc for linked doc (to get title)
      .mockReturnValueOnce({ meta: makeReqMeta({ id: 'linked-id', title: 'Linked Title' }), body: '' });

    const result = await getWikiDocById('doc-001');

    expect(result!.linkedDocs).toEqual([{ id: 'linked-id', title: 'Linked Title' }]);
  });
});
