// RequirementsDoc edit routes — B2-009
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger, findSddDocById, readSddDoc, updateSddFrontmatter } from '@dommaker/studio-shared';

const router = Router();

// PUT /api/v1/requirements-docs/:id
router.put('/:id', async (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'content is required' });
  }

  // SP-004: SDD-first read, DB fallback
  const slug = findSddDocById(req.params.id);
  let status = 'draft';
  if (slug) {
    const sddDoc = readSddDoc(slug, 'requirement');
    if (sddDoc?.meta.status) status = sddDoc.meta.status;
  } else {
    const doc = await prisma.requirementsDoc.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!doc) return res.status(404).json({ success: false, error: 'RequirementsDoc not found' });
    status = doc.status;
  }

  if (status === 'confirmed' || status === 'done') {
    return res.status(400).json({ success: false, error: 'Cannot edit confirmed/done RequirementsDoc' });
  }

  // Dual-write: DB + SDD
  await prisma.requirementsDoc.update({
    where: { id: req.params.id },
    data: { content, status: 'draft' },
  });
  if (slug) {
    try {
      updateSddFrontmatter(slug, { status: 'draft', updatedAt: new Date().toISOString() });
    } catch (e) {
      logger.warn('[RequirementsDoc] SDD frontmatter update failed (non-blocking)', { error: String(e) });
    }
  }
  logger.info('[RequirementsDoc] Updated', { id: req.params.id });
  res.json({ success: true, data: { updated: true } });
});

export default router;
