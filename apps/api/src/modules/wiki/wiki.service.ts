/**
 * Wiki service — SDD-based read logic
 *
 * Migrated from DB reads to SDD file reads.
 * DB fallback preserved for backward compatibility.
 */

import {
  listSddDocs,
  readSddDoc,
  findSddDocById,
  type SddFrontmatter,
} from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

// ── Types ──

export interface WikiListItem {
  id: string;
  title: string;
  tags: string[];
  status: string;
  goalId?: string;
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
  status: string;
  tags: string[];
  goalId?: string;
  sourceChannelId?: string;
  tier?: string;
  linkedDocIds: string[];
  linkedDocs: { id: string; title: string }[];
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
 * SDD-first, DB fallback when SDD returns empty.
 */
export async function listWikiDocs(filters: {
  search?: string;
  status?: string;
}): Promise<WikiListItem[]> {
  const slugs = listSddDocs();

  if (slugs.length > 0) {
    // SDD path
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
        goalId: meta.goalId,
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

  // DB fallback
  logger.info('[Wiki] SDD empty, falling back to DB');
  const where: Record<string, unknown> = {};

  if (filters.status) {
    const statuses = filters.status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      where.status = { in: statuses };
    }
  }

  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search } },
      { content: { contains: filters.search } },
    ];
  }

  const dbDocs = await prisma.requirementsDoc.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      tags: true,
      status: true,
      goalId: true,
      projectId: true,
      sourceChannelId: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  return dbDocs.map(doc => ({
    id: doc.id,
    title: doc.title,
    tags: typeof doc.tags === 'string' ? parseLinkedDocIds(doc.tags) : (doc.tags ?? []),
    status: doc.status,
    goalId: doc.goalId ?? undefined,
    projectId: doc.projectId ?? undefined,
    sourceChannelId: doc.sourceChannelId ?? undefined,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  }));
}

// ── buildWikiGraph ──

/**
 * Build wiki graph (nodes + edges) from SDD files.
 * SDD-first, DB fallback when SDD returns empty.
 */
export async function buildWikiGraph(): Promise<{
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}> {
  const slugs = listSddDocs();

  if (slugs.length > 0) {
    // SDD path — single pass: read all docs, build nodes + edges
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

  // DB fallback
  logger.info('[Wiki] SDD empty, falling back to DB for graph');
  const dbDocs = await prisma.requirementsDoc.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      linkedDocIds: true,
    },
  });

  const nodes: WikiGraphNode[] = dbDocs.map(doc => ({
    id: doc.id,
    name: doc.title,
    status: doc.status,
  }));

  const edges: WikiGraphEdge[] = [];
  const docIdSet = new Set(dbDocs.map(d => d.id));

  for (const doc of dbDocs) {
    const linkedIds = parseLinkedDocIds(doc.linkedDocIds);
    for (const targetId of linkedIds) {
      if (docIdSet.has(targetId)) {
        edges.push({ source: doc.id, target: targetId });
      }
    }
  }

  return { nodes, edges };
}

// ── getWikiDocById ──

/**
 * Get wiki document by ID with all 3 layers + link resolution.
 * SDD-first, DB fallback when SDD not found.
 */
export async function getWikiDocById(id: string): Promise<WikiDocDetail | null> {
  const slug = findSddDocById(id);

  if (slug) {
    // SDD path
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

    return {
      id: meta.id!,
      title: meta.title ?? slug,
      status: meta.status ?? 'draft',
      tags: meta.tags ?? [],
      goalId: meta.goalId,
      sourceChannelId: meta.sourceChannelId,
      tier: meta.tier,
      linkedDocIds,
      linkedDocs,
      requirement: req.body,
      design: design?.body ?? null,
      task: task?.body ?? null,
      createdAt: meta.createdAt ?? '',
      updatedAt: meta.updatedAt ?? '',
    };
  }

  // DB fallback
  logger.info('[Wiki] SDD not found, falling back to DB', { id });
  const doc = await prisma.requirementsDoc.findUnique({
    where: { id },
  });

  if (!doc) return null;

  // Parse linkedDocIds
  const linkedDocIds = parseLinkedDocIds(doc.linkedDocIds);

  // Resolve linked docs
  let linkedDocs: { id: string; title: string }[] = [];
  if (linkedDocIds.length > 0) {
    linkedDocs = await prisma.requirementsDoc.findMany({
      where: { id: { in: linkedDocIds } },
      select: { id: true, title: true },
    });
  }

  // Backlinks
  const allDocs = await prisma.requirementsDoc.findMany({
    where: { id: { not: doc.id } },
    select: { id: true, title: true, linkedDocIds: true },
  });

  const backlinks: { id: string; title: string }[] = [];
  for (const other of allDocs) {
    const otherLinkedIds = parseLinkedDocIds(other.linkedDocIds);
    if (otherLinkedIds.includes(doc.id)) {
      backlinks.push({ id: other.id, title: other.title });
    }
  }

  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    tags: typeof doc.tags === 'string' ? parseLinkedDocIds(doc.tags) : (doc.tags ?? []),
    goalId: doc.goalId ?? undefined,
    sourceChannelId: doc.sourceChannelId ?? undefined,
    linkedDocIds,
    linkedDocs,
    requirement: doc.content ?? null,
    design: null,
    task: null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
  };
}
