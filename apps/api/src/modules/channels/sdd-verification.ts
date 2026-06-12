/**
 * SP-004: SDD read path verification (non-blocking enrichment)
 *
 * Verifies SDD file exists for a RequirementsDoc. Logging only — does not
 * affect pipeline logic. DB remains the primary source.
 */
import { logger, readSddDoc, findSddDocById } from '@dommaker/studio-shared';

/**
 * Verify SDD file exists for the given doc.
 * Non-blocking: all errors are swallowed.
 */
export async function verifySddFile(opts: {
  docId: string;
  sddSlug?: string;
}): Promise<void> {
  try {
    const slug = opts.sddSlug || findSddDocById(opts.docId);
    if (!slug) return;
    const sddReq = readSddDoc(slug, 'requirement');
    if (sddReq) {
      logger.info('[Channel] SDD file verified', {
        slug,
        docId: opts.docId,
        sddStatus: sddReq.meta.status,
      });
    }
  } catch {
    /* non-blocking */
  }
}
