import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import { processMessage } from '../lib/chatService';
import { getKB } from '../lib/kbService';
import { ChatContinuation, StoredChatMessage } from '../types/chat';
import { getGeminiModelId } from '../lib/geminiModels';
import { nextGoogleGenerativeAI } from '../lib/geminiKeys';
import { getSession } from '../lib/sessionService';
import {
  jdFingerprint,
  saveInterviewPrep,
  getAllInterviewPrep,
  normalizeStoredQuestions,
} from '../lib/interviewPrepStorage';
import {
  listChatSessions,
  createChatSession,
  updateChatSessionTitle,
  deleteChatSession,
  getSessionMessages,
  appendSessionMessages,
  maybeAutoTitleFromFirstMessage,
  clearAllChatData,
} from '../lib/chatSessionService';

const router = Router();

/**
 * POST /api/chat/message
 * Accepts { message, history }. Routes intent via Gemini. Returns { intent, reply, data }.
 */
router.post('/message', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  const { message, history = [], continuation, sessionId } = req.body as {
    message?: string;
    history: StoredChatMessage[];
    continuation?: ChatContinuation;
    sessionId?: string;
  };

  const msg =
    typeof message === 'string' ? message.trim() : '';
  const hasContinuation =
    continuation &&
    typeof continuation === 'object' &&
    (continuation.type === 'group_update_pick' ||
      continuation.type === 'peer_compare_pick');

  if (!msg && !hasContinuation) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const uid = req.uid!;
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const response = await processMessage(
      uid,
      msg || '(action)',
      history,
      hasContinuation ? continuation : undefined
    );

    const now = new Date().toISOString();
    const userMsg: StoredChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: msg || 'Selected an option in chat',
      timestamp: now,
    };
    const botMsg: StoredChatMessage = {
      id: uuidv4(),
      role: 'bot',
      content: response.reply,
      intent: response.intent,
      timestamp: new Date(Date.now() + 1).toISOString(),
      ...(response.intent === 'update_kb' &&
      response.data &&
      response.data.section &&
      response.data.patch !== undefined
        ? {
            data: {
              section: response.data.section,
              patch: response.data.patch,
              patchSummary: response.data.patchSummary,
              currentSection: response.data.currentSection,
            },
          }
        : {}),
    };

    appendSessionMessages(uid, sid, [userMsg, botMsg]).catch((err) =>
      console.error('[chat/message] Firestore save failed:', err)
    );
    if (msg.trim()) {
      maybeAutoTitleFromFirstMessage(uid, sid, msg).catch((err) =>
        console.error('[chat/message] auto-title failed:', err)
      );
    }

    res.json(response);
  } catch (err) {
    console.error('[POST /chat/message]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/chat/sessions
 * Lists chat sessions (most recently updated first).
 */
router.get('/sessions', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sessions = await listChatSessions(req.uid!);
    res.json({ sessions });
  } catch (err) {
    console.error('[GET /chat/sessions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/chat/sessions
 * Body: { title?: string }. Creates a new empty session.
 */
router.post('/sessions', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const session = await createChatSession(req.uid!, title);
    res.status(201).json({ session });
  } catch (err) {
    console.error('[POST /chat/sessions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/chat/sessions/:sessionId
 * Body: { title: string }
 */
router.patch('/sessions/:sessionId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    if (!title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    await updateChatSessionTitle(req.uid!, sessionId, title);
    res.json({ message: 'Updated' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('not found')) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    console.error('[PATCH /chat/sessions/:sessionId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/chat/sessions/:sessionId
 */
router.delete('/sessions/:sessionId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await deleteChatSession(req.uid!, req.params.sessionId);
    res.json({ message: 'Session deleted' });
  } catch (err) {
    console.error('[DELETE /chat/sessions/:sessionId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/chat/history?sessionId=
 * Returns stored messages for one session (up to cap).
 */
router.get('/history', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId query parameter is required' });
      return;
    }
    const history = await getSessionMessages(req.uid!, sessionId);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('not found') || msg.includes('required')) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    console.error('[GET /chat/history]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/chat/history
 * Clears all sessions and legacy flat history for the user.
 */
router.delete('/history', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await clearAllChatData(req.uid!);
    res.json({ message: 'All chats cleared' });
  } catch (err) {
    console.error('[DELETE /chat/history]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/chat/interview-prep
 * Returns saved questionnaires (general + role) and whether session JD differs from saved role prep.
 */
router.get('/interview-prep', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { general, role } = await getAllInterviewPrep(uid);
    const session = await getSession(uid);
    const sessionJd = typeof session?.jd === 'string' ? session.jd.trim() : '';
    let jdStale = false;
    if (role?.jdFingerprint) {
      if (sessionJd.length < 80) {
        jdStale = true;
      } else {
        jdStale = jdFingerprint(sessionJd) !== role.jdFingerprint;
      }
    }
    res.json({ general, role, jdStale });
  } catch (err) {
    console.error('[GET /chat/interview-prep]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/chat/interview-prep
 * Accepts { jd?: string, mode?: 'general' | 'role' }.
 * - general: role-agnostic prep (no specific employer/JD).
 * - role: requires jd; questions aligned to posting + KB.
 * Persists result under users/{uid}/interviewPrep/{general|role}.
 */
router.post('/interview-prep', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body as { jd?: string; mode?: string };
    const jdTrim = typeof body.jd === 'string' ? body.jd.trim() : '';
    const modeParam = body.mode === 'general' || body.mode === 'role' ? body.mode : undefined;
    const mode: 'general' | 'role' =
      modeParam ?? (jdTrim.length > 0 ? 'role' : 'general');

    const uid = req.uid!;
    const kb = await getKB(uid);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found. Upload your resume first.' });
      return;
    }

    if (mode === 'role' && jdTrim.length < 80) {
      res.status(400).json({
        error:
          'Role-specific prep needs a full job description (about 80+ characters). Generate a resume from a JD first or paste the posting.',
      });
      return;
    }

    const kbJson = JSON.stringify(kb, null, 2);

    const jsonShape =
      'Return ONLY JSON: { "questions": [{ "type": string, "question": string, "hint": string, "answer": string }] }. Do not add explanation or markdown. Each "answer" must be a first-person speaking draft (2–5 sentences) grounded ONLY in the KB' +
      (mode === 'role' ? ' and the job description above' : '') +
      '; do not invent employers, titles, dates, or metrics not present. If the KB lacks detail for a strong answer, say what they could honestly add or how to frame honestly.';

    let taskBlock: string;
    if (mode === 'general') {
      taskBlock = `You are an interview coach. The candidate is preparing for interviews in general — there is NO specific job posting or employer.

Generate exactly 10 questions using their knowledge base only for personalization (stories, projects, skills). Do NOT mention a specific company, job title from a posting, or "this role" as if tied to one employer. Use types such as: Behavioral, Situational, Technical, General, Motivation.

Mix:
- 2 motivation / "tell me about yourself" / why-this-field style
- 3 STAR behavioral questions grounded in patterns from their experience
- 2 technical or system-design questions that fit their stack but are not tied to one JD
- 2 situational / judgment questions
- 1 meta question they could ask the interviewer

For each question, give a 2-3 sentence hint on what a strong answer would include, AND a separate "answer" field: a first-person draft they could say aloud.

${jsonShape}`;
    } else {
      taskBlock = `You are a senior technical interviewer. Generate exactly 10 interview questions tailored to BOTH the candidate's knowledge base AND the target job description below.

Align technical and role-fit questions to the JD's responsibilities, stack, and keywords. Include behavioral questions grounded in their actual experience from the KB. Use clear "type" labels (e.g. Technical, Behavioral, Situational, Role-fit).

For each question, give a 2-3 sentence hint on what a strong answer would include, AND a separate "answer" field: a first-person draft tying their KB evidence to this JD where relevant.

Target job description:
\`\`\`
${jdTrim}
\`\`\`

${jsonShape}`;
    }

    const prompt = `${taskBlock}

Candidate's KB:
\`\`\`json
${kbJson}
\`\`\``;

    const model = nextGoogleGenerativeAI().getGenerativeModel({ model: getGeminiModelId() });
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), 45_000)
      ),
    ]);

    const raw = result.response.text().trim();
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonStr) as { questions?: unknown };
    const questions = normalizeStoredQuestions(parsed.questions);
    if (!questions.length) {
      res.status(502).json({ error: 'Could not parse interview questions. Try again.' });
      return;
    }

    const fp = mode === 'role' ? jdFingerprint(jdTrim) : null;
    await saveInterviewPrep(uid, mode, questions, fp);

    res.json({ questions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg === 'TIMEOUT') {
      res.status(503).json({ error: 'I took too long to think. Try again in a moment.' });
      return;
    }
    console.error('[POST /chat/interview-prep]', err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

export default router;
