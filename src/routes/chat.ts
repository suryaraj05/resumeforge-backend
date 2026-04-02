import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import { processMessage, getChatHistory, saveChatMessages } from '../lib/chatService';
import { getKB } from '../lib/kbService';
import { db } from '../lib/firebase';
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

const router = Router();

/**
 * POST /api/chat/message
 * Accepts { message, history }. Routes intent via Gemini. Returns { intent, reply, data }.
 */
router.post('/message', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  const { message, history = [], continuation } = req.body as {
    message?: string;
    history: StoredChatMessage[];
    continuation?: ChatContinuation;
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
    };

    // Save to Firestore async (non-blocking)
    saveChatMessages(uid, [userMsg, botMsg]).catch((err) =>
      console.error('[chat/message] Firestore save failed:', err)
    );

    res.json(response);
  } catch (err) {
    console.error('[POST /chat/message]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/chat/history
 * Returns stored chat history (up to 100 messages).
 */
router.get('/history', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const history = await getChatHistory(req.uid!);
    res.json({ history });
  } catch (err) {
    console.error('[GET /chat/history]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/chat/history
 * Clears all chat history for the user.
 */
router.delete('/history', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const snap = await db.collection('users').doc(uid).collection('chatHistory').get();
    if (snap.size) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    res.json({ message: 'Chat history cleared' });
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
