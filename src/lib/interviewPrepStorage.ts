import crypto from 'crypto';
import { db } from './firebase';

const COLLECTION = 'interviewPrep';

export function jdFingerprint(jd: string): string {
  return crypto.createHash('sha256').update(jd.trim()).digest('hex').slice(0, 24);
}

export interface StoredInterviewQuestion {
  type?: string;
  question?: string;
  q?: string;
  hint: string;
  answer: string;
}

export interface InterviewPrepSavedDoc {
  mode: 'general' | 'role';
  jdFingerprint: string | null;
  questions: StoredInterviewQuestion[];
  updatedAt: string;
}

/** Firestore rejects `undefined`; only include optional keys when set. */
function sanitizeQuestionsForFirestore(questions: StoredInterviewQuestion[]): Record<string, string>[] {
  return questions.map((q) => {
    const row: Record<string, string> = {
      hint: q.hint ?? '',
      answer: q.answer ?? '',
    };
    if (q.type != null && q.type !== '') row.type = q.type;
    if (q.question != null && String(q.question).trim() !== '') row.question = String(q.question).trim();
    if (q.q != null && String(q.q).trim() !== '') row.q = String(q.q).trim();
    return row;
  });
}

export async function saveInterviewPrep(
  userId: string,
  mode: 'general' | 'role',
  questions: StoredInterviewQuestion[],
  jdFingerprintVal: string | null
): Promise<void> {
  const ref = db.collection('users').doc(userId).collection(COLLECTION).doc(mode);
  await ref.set({
    mode,
    jdFingerprint: jdFingerprintVal,
    questions: sanitizeQuestionsForFirestore(questions),
    updatedAt: new Date().toISOString(),
  });
}

export async function getInterviewPrepDoc(
  userId: string,
  mode: 'general' | 'role'
): Promise<InterviewPrepSavedDoc | null> {
  const snap = await db.collection('users').doc(userId).collection(COLLECTION).doc(mode).get();
  if (!snap.exists) return null;
  const d = snap.data() as Partial<InterviewPrepSavedDoc>;
  if (!Array.isArray(d.questions)) return null;
  return {
    mode: d.mode === 'role' ? 'role' : 'general',
    jdFingerprint: typeof d.jdFingerprint === 'string' ? d.jdFingerprint : null,
    questions: d.questions as StoredInterviewQuestion[],
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : new Date().toISOString(),
  };
}

export async function getAllInterviewPrep(userId: string): Promise<{
  general: InterviewPrepSavedDoc | null;
  role: InterviewPrepSavedDoc | null;
}> {
  const [general, role] = await Promise.all([
    getInterviewPrepDoc(userId, 'general'),
    getInterviewPrepDoc(userId, 'role'),
  ]);
  return { general, role };
}

/** Coerce model output into stored question rows. */
export function normalizeStoredQuestions(raw: unknown): StoredInterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => x != null && typeof x === 'object')
    .map((r) => ({
      type: typeof r.type === 'string' ? r.type : undefined,
      question: typeof r.question === 'string' ? r.question : undefined,
      q: typeof r.q === 'string' ? r.q : undefined,
      hint: typeof r.hint === 'string' ? r.hint : '',
      answer: typeof r.answer === 'string' ? r.answer : '',
    }))
    .filter(
      (q) =>
        (q.question || q.q || '').trim().length > 0 ||
        q.hint.length > 0 ||
        q.answer.length > 0
    );
}
