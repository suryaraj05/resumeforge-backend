import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import {
  upsertApplicationsFromSearch,
  findApplicationByJobId,
  updateApplication,
  deleteApplication,
  listApplicationsGrouped,
  getApplication,
} from '../lib/applicationsService';
import type { ApplicationStatus, ScoredJob } from '../types/jobs';

const router = Router();

/**
 * GET /api/applications
 */
router.get('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const grouped = await listApplicationsGrouped(req.uid!);
    res.json(grouped);
  } catch (err) {
    console.error('[GET /applications]', err);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

/**
 * GET /api/applications/:applicationId
 */
router.get('/:applicationId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const app = await getApplication(req.uid!, req.params.applicationId);
    if (!app) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json(app);
  } catch (err) {
    console.error('[GET /applications/:id]', err);
    res.status(500).json({ error: 'Failed to load application' });
  }
});

/**
 * POST /api/applications
 * Upserts by jobId (same as job search sync), then optionally merges resume/cover letter/ATS/status.
 */
router.post('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body as Partial<ScoredJob> & {
      status?: ApplicationStatus;
      resumeJson?: unknown;
      coverLetter?: string;
      atsScore?: number;
    };
    if (!body.jobId || !body.title || !body.company || !body.description || !body.score) {
      res.status(400).json({ error: 'jobId, title, company, description, and score are required' });
      return;
    }
    const job = body as ScoredJob;
    const uid = req.uid!;
    await upsertApplicationsFromSearch(uid, [job]);

    let doc = await findApplicationByJobId(uid, job.jobId);
    if (!doc) {
      res.status(500).json({ error: 'Failed to save application' });
      return;
    }

    if (body.resumeJson !== undefined || body.coverLetter !== undefined || body.atsScore !== undefined) {
      await updateApplication(uid, doc.applicationId, {
        resumeJson: body.resumeJson,
        coverLetter: body.coverLetter,
        atsScore: body.atsScore,
      });
    }
    if (body.status && body.status !== doc.status) {
      await updateApplication(uid, doc.applicationId, { status: body.status });
    }

    const final = await getApplication(uid, doc.applicationId);
    res.status(200).json(final);
  } catch (err) {
    console.error('[POST /applications]', err);
    res.status(500).json({ error: 'Failed to save application' });
  }
});

/**
 * PUT /api/applications/:applicationId
 */
router.put('/:applicationId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { applicationId } = req.params;
    const patch = req.body as Parameters<typeof updateApplication>[2];
    await updateApplication(req.uid!, applicationId, patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /applications/:id]', err);
    const msg = err instanceof Error && err.message === 'Application not found' ? 404 : 500;
    res.status(msg).json({ error: err instanceof Error ? err.message : 'Update failed' });
  }
});

/**
 * DELETE /api/applications/:applicationId
 */
router.delete('/:applicationId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await deleteApplication(req.uid!, req.params.applicationId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /applications/:id]', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
