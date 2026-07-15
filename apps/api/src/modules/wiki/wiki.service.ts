/**
 * Wiki service — SDD-based read logic
 *
 * Migrated from DB reads to SDD file reads.
 * All reads are SDD-only (no DB fallback).
 */

import {
  listSddDocs,
  readSddDoc,
  findSddDocById,
} from '@dommaker/studio-shared';

// ── Types ──

export interface WikiListItem {
  id: string;
  title: string;
  tags: string[];
  status: string;
  workUnitId?: string;
  projectId?: string;
  sourceChannelId?: string;
  updatedAt: string;
  createdAt: string;
}

export interface WikiGraphNode {
  id: string;
  name: string;
  status: string;
}

export interface WikiGraphEdge {
  source: string;
  target: string;
}

export interface WikiDocDetail {
  id: string;
  title: string;
  content: string;
  status: string;
  tags: string[];
  workUnitId?: string;
  sourceChannelId?: string;
  tier?: string;
  linkedDocIds: string[];
  linkedDocs: { id: string; title: string }[];
  wikiLinks: { id: string; title: string }[];
  backlinks: { id: string; title: string }[];
  requirement: string | null;
  design: string | null;
  task: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ──

/** Parse linkedDocIds — handles both string[] and string (JSON) */
function parseLinkedDocIds(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── listWikiDocs ──

/**
 * List wiki documents with optional search/status filters.
 * SDD-only reads.
 */
export function listWikiDocs(filters: {
  search?: string;
  status?: string;
}): WikiListItem[] {
  const slugs = listSddDocs();
  const docs: WikiListItem[] = [];

  for (const slug of slugs) {
    const doc = readSddDoc(slug, 'requirement');
    if (!doc?.meta.id) continue;

    const meta = doc.meta;
    const item: WikiListItem = {
      id: meta.id!,
      title: meta.title ?? slug,
      tags: meta.tags ?? [],
      status: meta.status ?? 'draft',
      workUnitId: meta.workUnitId,
      sourceChannelId: meta.sourceChannelId,
      updatedAt: meta.updatedAt ?? meta.createdAt ?? '',
      createdAt: meta.createdAt ?? '',
    };

    // Status filter
    if (filters.status) {
      const allowed = filters.status.split(',').map(s => s.trim());
      if (!allowed.includes(item.status)) continue;
    }

    // Search filter (title + body)
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const titleMatch = item.title.toLowerCase().includes(q);
      const bodyMatch = doc.body.toLowerCase().includes(q);
      if (!titleMatch && !bodyMatch) continue;
    }

    docs.push(item);
  }

  // Sort by updatedAt desc
  docs.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return docs;
}

// ── buildWikiGraph ──

/**
 * Build wiki graph (nodes + edges) from SDD files.
 * SDD-only reads.
 */
export function buildWikiGraph(): {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
} {
  const slugs = listSddDocs();
  const nodes: WikiGraphNode[] = [];
  const docIdSet = new Set<string>();
  const docsMeta: { id: string; linkedDocIds: string[] }[] = [];

  for (const slug of slugs) {
    const doc = readSddDoc(slug, 'requirement');
    if (!doc?.meta.id) continue;

    const node: WikiGraphNode = {
      id: doc.meta.id,
      name: doc.meta.title ?? slug,
      status: doc.meta.status ?? 'draft',
    };
    nodes.push(node);
    docIdSet.add(node.id);
    docsMeta.push({ id: node.id, linkedDocIds: parseLinkedDocIds(doc.meta.linkedDocIds) });
  }

  // Build edges from cached metadata
  const edges: WikiGraphEdge[] = [];
  for (const meta of docsMeta) {
    for (const targetId of meta.linkedDocIds) {
      if (docIdSet.has(targetId)) {
        edges.push({ source: meta.id, target: targetId });
      }
    }
  }

  return { nodes, edges };
}

// ── getWikiDocById ──

/**
 * Get wiki document by ID with all 3 layers + link resolution.
 * SDD-only reads.
 */
export function getWikiDocById(id: string): WikiDocDetail | null {
  const slug = findSddDocById(id);
  if (!slug) return null;

  const req = readSddDoc(slug, 'requirement');
  const design = readSddDoc(slug, 'design');
  const task = readSddDoc(slug, 'task');

  if (!req) return null;

  const meta = req.meta;
  const linkedDocIds = parseLinkedDocIds(meta.linkedDocIds);

  // Resolve linked docs to { id, title }
  const linkedDocs: { id: string; title: string }[] = [];
  for (const linkedId of linkedDocIds) {
    const linkedSlug = findSddDocById(linkedId);
    if (linkedSlug) {
      const linkedReq = readSddDoc(linkedSlug, 'requirement');
      if (linkedReq?.meta.title) {
        linkedDocs.push({ id: linkedId, title: linkedReq.meta.title });
      }
    }
  }

  // Compute backlinks: docs whose linkedDocIds point to this doc
  const backlinks: { id: string; title: string }[] = [];
  const allSlugs = listSddDocs();
  for (const otherSlug of allSlugs) {
    if (otherSlug === slug) continue;
    const otherReq = readSddDoc(otherSlug, 'requirement');
    if (!otherReq?.meta.id) continue;
    const otherLinkedIds = parseLinkedDocIds(otherReq.meta.linkedDocIds);
    if (otherLinkedIds.includes(id)) {
      backlinks.push({ id: otherReq.meta.id, title: otherReq.meta.title ?? otherSlug });
    }
  }

  // Compute wikiLinks: [[links]] parsed from content -> resolved to doc IDs
  const wikiLinks: { id: string; title: string }[] = [];
  const allContent = [req.body, design?.body, task?.body].filter(Boolean).join('\n');
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
  const seenWikiLinks = new Set<string>();
  let match;
  while ((match = wikiLinkRegex.exec(allContent)) !== null) {
    const linkRef = match[1].trim();
    if (seenWikiLinks.has(linkRef)) continue;
    seenWikiLinks.add(linkRef);
    // Try resolving as doc ID first, then as slug
    const linkedSlug = findSddDocById(linkRef) ?? linkRef;
    const linkedReq = readSddDoc(linkedSlug, 'requirement');
    if (linkedReq?.meta.id && linkedReq.meta.id !== id) {
      wikiLinks.push({ id: linkedReq.meta.id, title: linkedReq.meta.title ?? linkedSlug });
    }
  }

  return {
    id: meta.id!,
    title: meta.title ?? slug,
    content: req.body,
    status: meta.status ?? 'draft',
    tags: meta.tags ?? [],
    workUnitId: meta.workUnitId,
    sourceChannelId: meta.sourceChannelId,
    tier: meta.tier,
    linkedDocIds,
    linkedDocs,
    wikiLinks,
    backlinks,
    requirement: req.body,
    design: design?.body ?? null,
    task: task?.body ?? null,
    createdAt: meta.createdAt ?? '',
    updatedAt: meta.updatedAt ?? '',
  };
}
