/**
 * AC-D3: Project Discovery API
 *
 * Endpoints:
 *   GET /api/v1/projects/discover — list discovered projects
 */
import { Router, type Request, type Response } from 'express';
import { ProjectDiscoveryService } from './project-discovery.service.js';
import { getErrorMessage } from '../../utils/errors.js';

const router = Router();
const service = new ProjectDiscoveryService();

/** GET /discover — scan local directories for projects */
router.get('/discover', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    const projects = search
      ? await service.search(search as string)
      : await service.discover();
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

export default router;
