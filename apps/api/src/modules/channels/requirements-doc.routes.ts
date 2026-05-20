// RequirementsDoc edit routes — B2-009
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

const router = Router();

// PUT /api/v1/requirements-docs/:id
router.put('/:id', async (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'content is required' });
  }
  const doc = await prisma.requirementsDoc.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ success: false, error: 'RequirementsDoc not found' });
  if (doc.status === 'confirmed' || doc.status === 'done') {
    return res.status(400).json({ success: false, error: 'Cannot edit confirmed/done RequirementsDoc' });
  }
  await prisma.requirementsDoc.update({
    where: { id: req.params.id },
    data: { content, status: 'draft' },
  });
  logger.info('[RequirementsDoc] Updated', { id: req.params.id });
  res.json({ success: true, data: { updated: true } });
});

export default router;
