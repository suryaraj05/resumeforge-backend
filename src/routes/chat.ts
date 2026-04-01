import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { geminiRateLimit } from '../middleware/rateLimiter';
import { processMessage, getChatHistory, saveChatMessages } from '../lib/chatService';
import { getKB } from '../lib/kbService';
import { db } from '../lib/firebase';
import { ChatContinuation, StoredChatMessage } from '../types/chat';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

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
 * POST /api/chat/interview-prep
 * Accepts { jd?: string }. Returns interview questions tailored to user's KB.
 * GEMINI_COST_ESTIMATE: ~2000-3000 input tokens (full KB + JD), ~600 output tokens
 */
router.post('/interview-prep', verifyToken, geminiRateLimit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { jd } = req.body as { jd?: string };
    const uid = req.uid!;
    const kb = await getKB(uid);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found. Upload your resume first.' });
      return;
    }

    const kbJson = JSON.stringify(kb, null, 2);
    const jdSection = jd?.trim()
      ? `Target JD (if provided):\n\`\`\`\n${jd.trim()}\n\`\`\``
      : 'Target JD: (not provided — use general software engineering/tech role)';

    const prompt = `You are a senior technical interviewer. Given a candidate's resume knowledge base and optionally a target job description, generate 10 likely interview questions. Mix: 3 technical questions based on their specific projects/skills, 3 behavioral questions based on their experience, 2 situational questions, 2 role-specific questions. For each question, give a 2-3 sentence hint on what a strong answer would include. Return ONLY JSON: { "questions": [{ "type": string, "question": string, "hint": string }] }. Do not add explanation or markdown.

Candidate's KB:
\`\`\`json
${kbJson}
\`\`\`

${jdSection}`;

    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), 45_000)
      ),
    ]);

    const raw = result.response.text().trim();
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonStr) as { questions: { type: string; question: string; hint: string }[] };

    res.json({ questions: parsed.questions ?? [] });
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
