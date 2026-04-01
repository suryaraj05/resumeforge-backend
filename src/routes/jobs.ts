import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import { searchJobsForUser } from '../lib/jobSearchService';
import { getOrInferJobProfile } from '../lib/jobProfileService';
import { getKB } from '../lib/kbService';
import { getStoredWeakSpotReport } from '../lib/weakSpotsService';
import { getSalaryIntel } from '../lib/salaryIntelService';
import { db } from '../lib/firebase';

const router = Router();

async function touchLastJobSearch(userId: string): Promise<void> {
  await db.collection('users').doc(userId).collection('meta').doc('jobSearch').set({
    lastSearchAt: new Date().toISOString(),
  }, { merge: true });
}

/**
 * GET /api/jobs/search
 */
router.get('/search', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const q = typeof req.query.query === 'string' ? req.query.query : undefined;
    const location = typeof req.query.location === 'string' ? req.query.location : undefined;
    const remote = req.query.remote === 'true' || req.query.remote === '1';
    const datePosted = typeof req.query.datePosted === 'string' ? req.query.datePosted : undefined;
    const roleType = typeof req.query.roleType === 'string' ? req.query.roleType : undefined;
    const page = req.query.page ? parseInt(String(req.query.page), 10) : 1;
    const indianStartups =
      req.query.indianStartups === 'true' ||
      req.query.indianStartups === '1' ||
      location === 'Indian Startups';

    const result = await searchJobsForUser(uid, {
      query: q,
      location,
      remote,
      datePosted,
      roleType,
      page: Number.isFinite(page) ? page : 1,
      indianStartups,
    });

    await touchLastJobSearch(uid);

    res.json({
      jobs: result.jobs,
      profile: result.profile,
      weakSpotReport: result.weakSpotReport,
      fromCache: result.fromCache,
      scoringCapped: result.scoringCapped,
    });
  } catch (err) {
    console.error('[GET /jobs/search]', err);
    const msg = err instanceof Error && err.message.includes('No knowledge base')
      ? 'No knowledge base found. Upload a resume first.'
      : 'Job search failed';
    const code = msg.includes('No knowledge base') ? 404 : 500;
    res.status(code).json({ error: msg });
  }
});

/**
 * GET /api/jobs/profile
 */
router.get('/profile', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const kb = await getKB(uid);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found' });
      return;
    }
    const { profile, refreshed } = await getOrInferJobProfile(uid);
    res.json({ profile, refreshed });
  } catch (err) {
    console.error('[GET /jobs/profile]', err);
    res.status(500).json({ error: 'Failed to load job profile' });
  }
});

/**
 * POST /api/jobs/profile/refresh
 */
router.post('/profile/refresh', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const kb = await getKB(uid);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found' });
      return;
    }
    const { profile } = await getOrInferJobProfile(uid, { force: true });
    res.json({ profile });
  } catch (err) {
    console.error('[POST /jobs/profile/refresh]', err);
    res.status(500).json({ error: 'Failed to refresh job profile' });
  }
});

/**
 * GET /api/jobs/weakspots
 */
router.get('/weakspots', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const meta = await db.collection('users').doc(uid).collection('meta').doc('jobSearch').get();
    const last = meta.data()?.lastSearchAt as string | undefined;
    let report = await getStoredWeakSpotReport(uid);

    const stale =
      !last ||
      (report &&
        Date.now() - new Date(report.generatedAt).getTime() > 24 * 60 * 60 * 1000);

    if (stale && req.query.regenerate === '1') {
      await searchJobsForUser(uid, { page: 1 });
      report = await getStoredWeakSpotReport(uid);
    }

    res.json({
      report,
      lastJobSearchAt: last ?? null,
      stale: !report || stale,
    });
  } catch (err) {
    console.error('[GET /jobs/weakspots]', err);
    res.status(500).json({ error: 'Failed to load weak spots' });
  }
});

/**
 * GET /api/jobs/salary-intel?company=&role=
 */
router.get('/salary-intel', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const company = typeof req.query.company === 'string' ? req.query.company : '';
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    if (!company || !role) {
      res.status(400).json({ error: 'company and role are required' });
      return;
    }
    const intel = await getSalaryIntel(company, role);
    res.json(intel);
  } catch (err) {
    console.error('[GET /jobs/salary-intel]', err);
    res.status(500).json({ error: 'Salary intel failed' });
  }
});

export default router;
