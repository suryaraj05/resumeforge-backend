import { Router, Response } from 'express';
import multer from 'multer';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import { storage } from '../lib/firebase';
import { parseResumeWithGemini } from '../lib/gemini';
import { writeKB, getKB } from '../lib/kbService';
import { saveSession, getSession } from '../lib/sessionService';
import {
  generateRefinedResume,
  scoreATS,
  generateCoverLetter,
  assessJobFit,
} from '../lib/resumeGenService';
import { renderResumePdf, renderCoverLetterPdf, ResumeTemplateId } from '../lib/pdfService';
import { RefinedResume } from '../types/resume';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  },
});

router.post(
  '/upload',
  verifyToken,
  upload.single('resume'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'No PDF file provided' });
      return;
    }
    const uid = req.uid!;
    const fileBuffer = req.file.buffer;
    try {
      const bucket = storage.bucket();
      await bucket.file(`resumes/${uid}/original.pdf`).save(fileBuffer, {
        metadata: { contentType: 'application/pdf' },
      });
    } catch (err) {
      console.error('[resume/upload] Storage upload failed:', err);
    }
    let resumeText: string;
    try {
      const parsed = await pdfParse(fileBuffer);
      resumeText = parsed.text;
      if (!resumeText || resumeText.trim().length < 50) {
        res.status(422).json({
          error: 'Could not parse resume. Please try again or use a cleaner PDF.',
        });
        return;
      }
    } catch {
      res.status(422).json({
        error: 'Could not parse resume. Please try again or use a cleaner PDF.',
      });
      return;
    }
    let geminiPatch;
    try {
      geminiPatch = await parseResumeWithGemini(resumeText);
    } catch (err) {
      const message = err instanceof SyntaxError
        ? 'Could not parse resume. Please try again or use a cleaner PDF.'
        : 'AI parsing failed. Please try again.';
      console.error('[resume/upload] Gemini failed:', err);
      res.status(422).json({ error: message });
      return;
    }
    try {
      const kb = await writeKB(uid, geminiPatch);
      res.status(200).json({ kb, parsed: geminiPatch });
    } catch (err) {
      console.error('[resume/upload] Firestore write failed:', err);
      res.status(500).json({ error: 'Failed to save knowledge base' });
    }
  }
);

router.get('/latest', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const kb = await getKB(req.uid!);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found' });
      return;
    }
    res.json(kb);
  } catch (err) {
    console.error('[GET /resume/latest]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/resume/generate
 * { jd: string }
 * GEMINI_COST_ESTIMATE: ~4000-8000 input tokens (full KB + JD), ~2000 output tokens
 */
router.post('/generate', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jd } = req.body as { jd: string };
    if (!jd || typeof jd !== 'string' || jd.trim().length < 80) {
      res.status(400).json({ error: 'A substantive job description (jd) is required' });
      return;
    }
    const uid = req.uid!;
    const kb = await getKB(uid);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found. Upload a resume first.' });
      return;
    }
    const refined = await generateRefinedResume(kb, jd.trim());
    const ats = await scoreATS(jd.trim(), refined);
    await saveSession(uid, { jd: jd.trim(), latestResume: refined, lastAts: ats });
    res.json({ refinedResume: refined, atsScore: ats });
  } catch (err) {
    console.error('[POST /resume/generate]', err);
    res.status(500).json({ error: 'Resume generation failed' });
  }
});

/**
 * POST /api/resume/pdf
 * { resumeJson, template }
 */
router.post('/pdf', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { resumeJson, template } = req.body as {
      resumeJson: RefinedResume;
      template: string;
    };
    if (!resumeJson || typeof resumeJson !== 'object') {
      res.status(400).json({ error: 'resumeJson is required' });
      return;
    }
    const t = (['minimal', 'modern', 'academic'].includes(template) ? template : 'minimal') as ResumeTemplateId;
    const buf = await renderResumePdf(resumeJson, t);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
    res.send(buf);
  } catch (err) {
    console.error('[POST /resume/pdf]', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

/**
 * POST /api/resume/ats
 * { jd, resumeJson }
 */
router.post('/ats', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jd, resumeJson } = req.body as { jd: string; resumeJson: RefinedResume };
    if (!jd || !resumeJson) {
      res.status(400).json({ error: 'jd and resumeJson are required' });
      return;
    }
    const ats = await scoreATS(jd, resumeJson);
    await saveSession(req.uid!, { lastAts: ats });
    res.json(ats);
  } catch (err) {
    console.error('[POST /resume/ats]', err);
    res.status(500).json({ error: 'ATS scoring failed' });
  }
});

/**
 * POST /api/resume/cover-letter
 * { jd, resumeJson }
 */
router.post('/cover-letter', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jd, resumeJson } = req.body as { jd: string; resumeJson: RefinedResume };
    if (!jd || !resumeJson) {
      res.status(400).json({ error: 'jd and resumeJson are required' });
      return;
    }
    const text = await generateCoverLetter(jd, resumeJson);
    await saveSession(req.uid!, { lastCoverLetter: text });
    res.json({ text });
  } catch (err) {
    console.error('[POST /resume/cover-letter]', err);
    res.status(500).json({ error: 'Cover letter generation failed' });
  }
});

/**
 * POST /api/resume/cover-letter/pdf
 * { text }
 */
router.post('/cover-letter/pdf', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { text } = req.body as { text: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const buf = await renderCoverLetterPdf(text);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="cover-letter.pdf"');
    res.send(buf);
  } catch (err) {
    console.error('[POST /resume/cover-letter/pdf]', err);
    res.status(500).json({ error: 'Cover letter PDF failed' });
  }
});

/**
 * POST /api/resume/job-fit
 * { jd }
 */
router.post('/job-fit', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jd } = req.body as { jd: string };
    if (!jd || jd.trim().length < 40) {
      res.status(400).json({ error: 'A substantive job description is required' });
      return;
    }
    const kb = await getKB(req.uid!);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found' });
      return;
    }
    const fit = await assessJobFit(jd.trim(), kb);
    res.json(fit);
  } catch (err) {
    console.error('[POST /resume/job-fit]', err);
    res.status(500).json({ error: 'Job fit assessment failed' });
  }
});

/**
 * GET /api/resume/session — latest JD + refined resume from Firestore
 */
router.get('/session', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await getSession(req.uid!);
    res.json(session ?? {});
  } catch (err) {
    console.error('[GET /resume/session]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
