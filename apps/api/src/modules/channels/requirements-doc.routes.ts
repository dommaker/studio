// RequirementsDoc edit routes — B2-009
import { Router } from 'express';
import { logger, findSddDocById, readSddDoc, updateSddFrontmatter } from '@dommaker/studio-shared';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

const router = Router();

// PUT /api/v1/requirements-docs/:id
router.put('/:id', requireAuth(), requireNotGuest(), async (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'content is required' });
  }

  // SP-004: SDD-only read
  const slug = await findSddDocById(req.params.id);
  if (!slug) return res.status(404).json({ success: false, error: 'RequirementsDoc not found' });
  const sddDoc = await readSddDoc(slug, 'requirement');
  const status = sddDoc?.meta.status ?? 'draft';

  if (status === 'confirmed' || status === 'done') {
    return res.status(400).json({ success: false, error: 'Cannot edit confirmed/done RequirementsDoc' });
  }

  // SP-004: SDD primary, DB fire-and-forget
  if (slug) {
    try {
      await updateSddFrontmatter(slug, { status: 'draft', updatedAt: new Date().toISOString() });
    } catch (e) {
      logger.warn('[RequirementsDoc] SDD frontmatter update failed', { error: String(e) });
    }
  }
  logger.info('[RequirementsDoc] Updated', { id: req.params.id });
  res.json({ success: true, data: { updated: true } });
});

export default router;
