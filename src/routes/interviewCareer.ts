import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import {
  startInterviewSession,
  evaluateAnswer,
  getSession,
  listSessions,
} from '../lib/interviewCareerService';
import type { InterviewFocus, InterviewMode } from '../types/jobs';

const router = Router();

/**
 * POST /api/interview/session/start
 */
router.post('/session/start', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { applicationId, mode, focus, company, role, jdText } = req.body as {
      applicationId?: string;
      mode?: string;
      focus?: string;
      company?: string;
      role?: string;
      jdText?: string;
    };

    const m = (mode === 'timed_mock' ? 'timed_mock' : 'chat_qa') as InterviewMode;
    const f: InterviewFocus =
      focus === 'technical' || focus === 'behavioral' ? focus : 'mixed';

    if (!company?.trim() || !role?.trim() || !jdText || jdText.length < 40) {
      res.status(400).json({ error: 'company, role, and jdText (40+ chars) are required' });
      return;
    }

    const session = await startInterviewSession({
      userId: req.uid!,
      applicationId: applicationId ?? null,
      company: company.trim(),
      role: role.trim(),
      jdText: jdText.trim(),
      mode: m,
      focus: f,
    });

    res.status(201).json(session);
  } catch (err) {
    console.error('[POST /interview/session/start]', err);
    res.status(500).json({ error: 'Failed to start interview session' });
  }
});

/**
 * POST /api/interview/session/:sessionId/answer
 */
router.post(
  '/session/:sessionId/answer',
  verifyToken,
  geminiRateLimit,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const { questionId, answer } = req.body as { questionId?: number; answer?: string };
      if (questionId == null || !answer || typeof answer !== 'string') {
        res.status(400).json({ error: 'questionId and answer are required' });
        return;
      }

      const out = await evaluateAnswer({
        userId: req.uid!,
        sessionId,
        questionId: Number(questionId),
        answer: answer.trim(),
      });

      res.json(out);
    } catch (err) {
      console.error('[POST /interview/session/:id/answer]', err);
      const msg = err instanceof Error ? err.message : 'Failed';
      const code = msg.includes('not found') ? 404 : 500;
      res.status(code).json({ error: msg });
    }
  }
);

/**
 * GET /api/interview/sessions
 */
router.get('/sessions', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sessions = await listSessions(req.uid!, 40);
    res.json({ sessions });
  } catch (err) {
    console.error('[GET /interview/sessions]', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/interview/sessions/:sessionId
 */
router.get('/sessions/:sessionId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const session = await getSession(req.uid!, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('[GET /interview/sessions/:id]', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

export default router;
