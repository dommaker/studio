/**
 * ExternalFetcher — fetch external docs and ingest as reference knowledge.
 *
 * Fetches URL content, strips HTML tags, and ingests into KnowledgeStore
 * with consumptionMode='reference', origin='external'.
 * Sanitization (injection patterns, length limit) handled by harness ingestExternal().
 */
import { sharedIngest } from '../knowledge-bus.service.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 200;

/**
 * Strip HTML tags and extract text content.
 * Removes script/style tags entirely, then strips remaining tags.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract title from HTML or URL.
 */
function extractTitle(html: string, url: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return stripHtml(titleMatch[1]).slice(0, MAX_TITLE_LENGTH);
  }
  // Fallback: use URL path
  try {
    const parsed = new URL(url);
    return parsed.pathname.slice(1).replace(/\//g, ' — ').slice(0, MAX_TITLE_LENGTH) || parsed.hostname;
  } catch {
    return url.slice(0, MAX_TITLE_LENGTH);
  }
}

/**
 * Fetch external URL and ingest as reference knowledge.
 * Returns the created KnowledgeEntry.
 */
export async function fetchExternal(url: string): Promise<{
  id: string; title: string; content: string;
}> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Studio-KnowledgeFetcher/1.0' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const rawText = await response.text();
  const contentType = response.headers.get('content-type') || '';

  let content: string;
  let title: string;

  if (contentType.includes('text/html')) {
    content = stripHtml(rawText);
    title = extractTitle(rawText, url);
  } else {
    content = rawText;
    title = extractTitle('', url);
  }

  // Extract domain for source attribution
  let domain = 'unknown';
  try {
    domain = new URL(url).hostname;
  } catch { /* ignore */ }

  const entry = sharedIngest.ingestExternal(
    {
      type: 'architecture',
      title,
      content,
      tags: ['external', domain],
    },
    {
      source: `external:${domain}`,
      layer: 'tech',
      consumptionMode: 'reference',
    },
  );

  return { id: entry.id, title: entry.title, content: entry.content };
}
