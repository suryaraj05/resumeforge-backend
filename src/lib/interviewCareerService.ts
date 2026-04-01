import { v4 as uuidv4 } from 'uuid';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from './firebase';
import { getKB } from './kbService';
import { getGeminiModelId } from './geminiModels';
import type {
  CompanyIntel,
  InterviewAnswerRecord,
  InterviewFocus,
  InterviewMode,
  InterviewQuestionItem,
  InterviewSessionDoc,
  ReadinessReport,
} from '../types/jobs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

function sessionsCol(userId: string) {
  return db.collection('users').doc(userId).collection('interviewSessions');
}

async function generateCompanyIntel(company: string, role: string, jdText: string): Promise<CompanyIntel> {
  const model = genAI.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: { responseMimeType: 'application/json' },
  });
  const system = `You are a recruiter at ${company}. Give a candidate a quick prep briefing. Return ONLY JSON: { interviewStyle: string, commonQuestions: [string (3)], cultureFit: string, redFlags: string, insiderTip: string }. If the company is not well-known, use the JD to infer.`;
  const user = `Company: ${company}\nRole: ${role}\nJD: ${jdText.slice(0, 3000)}`;
  const result = await model.generateContent(`${system}\n\n${user}`);
  const raw = result.response.text().trim();
  const p = JSON.parse(extractJSON(raw)) as CompanyIntel;
  return {
    interviewStyle: String(p.interviewStyle ?? ''),
    commonQuestions: Array.isArray(p.commonQuestions) ? p.commonQuestions.map(String).slice(0, 3) : [],
    cultureFit: String(p.cultureFit ?? ''),
    redFlags: String(p.redFlags ?? ''),
    insiderTip: String(p.insiderTip ?? ''),
  };
}

async function generateQuestions(
  company: string,
  role: string,
  focus: InterviewFocus,
  jdText: string,
  kbJson: string
): Promise<InterviewQuestionItem[]> {
  const model = genAI.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: { responseMimeType: 'application/json' },
  });
  const system = `You are a senior interviewer at ${company}. Generate a personalized interview question set for a candidate applying for ${role}. Use their resume to make questions specific. Mix question types based on focus: ${focus}. Return ONLY JSON: { company: string, role: string, questions: [{ id: number, type: string, difficulty: string, question: string, hints: [string], followUp: string }] }. Generate exactly 10 questions.`;
  const user = `Candidate's KB:\n${kbJson}\n\nTarget company: ${company}\nTarget role: ${role}\nFocus: ${focus}\n\nJob description:\n${jdText.slice(0, 4000)}`;
  const result = await model.generateContent(`${system}\n\n${user}`);
  const raw = result.response.text().trim();
  const parsed = JSON.parse(extractJSON(raw)) as { questions?: InterviewQuestionItem[] };
  const qs = (parsed.questions ?? []).slice(0, 10);
  return qs.map((q, i) => ({
    id: typeof q.id === 'number' ? q.id : i + 1,
    type: String(q.type ?? 'mixed'),
    difficulty: String(q.difficulty ?? 'medium'),
    question: String(q.question ?? ''),
    hints: Array.isArray(q.hints) ? q.hints.map(String) : [],
    followUp: String(q.followUp ?? ''),
  }));
}

function buildReadinessReport(
  company: string,
  role: string,
  answers: InterviewAnswerRecord[],
  questions: InterviewQuestionItem[]
): ReadinessReport {
  const scored = answers.filter((a) => typeof a.score === 'number');
  const avg =
    scored.length > 0 ? scored.reduce((s, a) => s + (a.score as number), 0) / scored.length : 0;
  let readinessLevel: ReadinessReport['readinessLevel'] = 'Needs work';
  if (avg >= 4.2) readinessLevel = 'Interview ready';
  else if (avg >= 3.5) readinessLevel = 'Almost there';
  else if (avg < 2.5) readinessLevel = 'Not ready';

  const byType: Record<string, number[]> = {};
  for (const a of scored) {
    const q = questions.find((x) => x.id === a.questionId);
    const t = q?.type ?? 'general';
    if (!byType[t]) byType[t] = [];
    byType[t].push(a.score as number);
  }
  let strongestArea = '—';
  let weakestArea = '—';
  let best = -1;
  let worst = 99;
  for (const [t, arr] of Object.entries(byType)) {
    const m = arr.reduce((x, y) => x + y, 0) / arr.length;
    if (m > best) {
      best = m;
      strongestArea = t;
    }
    if (m < worst) {
      worst = m;
      weakestArea = t;
    }
  }

  return {
    company,
    role,
    date: new Date().toISOString(),
    overallScore: Math.round(avg * 10) / 10,
    readinessLevel,
    strongestArea,
    weakestArea,
    suggestions: [
      'Practice STAR stories for behavioral prompts.',
      'Re-read your toughest question and outline a 60-second answer.',
      'Research one recent company launch or blog post to cite in conversation.',
    ],
    questionBreakdown: scored.map((a) => {
      const q = questions.find((x) => x.id === a.questionId);
      return {
        question: q?.question ?? `Q${a.questionId}`,
        score: a.score ?? 0,
        type: q?.type ?? '—',
      };
    }),
  };
}

export async function startInterviewSession(params: {
  userId: string;
  applicationId?: string | null;
  company: string;
  role: string;
  jdText: string;
  mode: InterviewMode;
  focus: InterviewFocus;
}): Promise<InterviewSessionDoc> {
  const kb = await getKB(params.userId);
  const kbJson = kb ? JSON.stringify(kb) : '{}';

  const sessionId = uuidv4();
  const now = new Date().toISOString();

  let companyIntel: CompanyIntel | null = null;
  let questions: InterviewQuestionItem[] = [];

  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      [companyIntel, questions] = await Promise.all([
        generateCompanyIntel(params.company, params.role, params.jdText),
        generateQuestions(params.company, params.role, params.focus, params.jdText, kbJson),
      ]);
    } catch (e) {
      console.error('[interviewCareer] generation failed', e);
    }
  }

  if (!questions.length) {
    questions = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      type: 'behavioral',
      difficulty: 'medium',
      question: `Tell me about a challenge you overcame relevant to ${params.role}. (Question ${i + 1})`,
      hints: ['Context', 'Action', 'Result'],
      followUp: 'What would you do differently?',
    }));
  }

  const doc: InterviewSessionDoc = {
    sessionId,
    userId: params.userId,
    applicationId: params.applicationId ?? null,
    company: params.company,
    role: params.role,
    jdText: params.jdText,
    mode: params.mode,
    focus: params.focus,
    companyIntel,
    questions,
    answers: [],
    currentQuestionIndex: 0,
    awaitingFollowUpFor: null,
    readinessReport: null,
    complete: false,
    createdAt: now,
    updatedAt: now,
  };

  await sessionsCol(params.userId).doc(sessionId).set(doc);
  return doc;
}

export async function evaluateAnswer(params: {
  userId: string;
  sessionId: string;
  questionId: number;
  answer: string;
}): Promise<{
  evaluation: InterviewAnswerRecord;
  session: InterviewSessionDoc;
  readinessReport?: ReadinessReport;
}> {
  const ref = sessionsCol(params.userId).doc(params.sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Session not found');
  const session = snap.data() as InterviewSessionDoc;

  const q = session.questions.find((x) => x.id === params.questionId);
  if (!q) throw new Error('Question not found');

  const kb = await getKB(params.userId);
  const kbSnippet = kb ? JSON.stringify(kb).slice(0, 6000) : '';

  let record: InterviewAnswerRecord = {
    questionId: params.questionId,
    answer: params.answer,
    score: 3,
    strengths: [],
    improvements: [],
    modelAnswer: '',
    askedFollowUp: false,
  };

  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      const model = genAI.getGenerativeModel({
        model: getGeminiModelId(),
        generationConfig: { responseMimeType: 'application/json' },
      });
      const system = `You are a senior interviewer evaluating a candidate's answer. Return ONLY JSON: { score: number (1-5), strengths: [string (max 2)], improvements: [string (max 2)], modelAnswer: string (3-4 sentences), askFollowUp: boolean (true if score >= 4) }.`;
      const user = `Question: ${q.question}\nHints for strong answer: ${q.hints.join('; ')}\nCandidate's answer: ${params.answer}\nCandidate's relevant KB context: ${kbSnippet}`;
      const result = await model.generateContent(`${system}\n\n${user}`);
      const raw = result.response.text().trim();
      const p = JSON.parse(extractJSON(raw)) as Record<string, unknown>;
      record = {
        questionId: params.questionId,
        answer: params.answer,
        score: Math.min(5, Math.max(1, Number(p.score) || 3)),
        strengths: Array.isArray(p.strengths) ? (p.strengths as string[]).slice(0, 2) : [],
        improvements: Array.isArray(p.improvements) ? (p.improvements as string[]).slice(0, 2) : [],
        modelAnswer: String(p.modelAnswer ?? ''),
        askedFollowUp: Boolean(p.askFollowUp) && Number(p.score) >= 4,
      };
    } catch (e) {
      console.warn('[interviewCareer] eval failed', e);
    }
  }

  const answers = [...session.answers.filter((a) => a.questionId !== params.questionId), record];

  const answeredIds = new Set(answers.map((a) => a.questionId));
  const nextUnanswered = session.questions.findIndex((qq) => !answeredIds.has(qq.id));
  const allAnswered = nextUnanswered === -1;

  let readinessReport: ReadinessReport | undefined;
  const complete = allAnswered;
  const currentQuestionIndex =
    allAnswered ? session.questions.length - 1 : nextUnanswered;

  if (allAnswered) {
    readinessReport = buildReadinessReport(session.company, session.role, answers, session.questions);
  }

  const updated: InterviewSessionDoc = {
    ...session,
    answers,
    currentQuestionIndex,
    awaitingFollowUpFor: null,
    complete,
    readinessReport: readinessReport ?? session.readinessReport ?? null,
    updatedAt: new Date().toISOString(),
  };

  await ref.set(updated);
  return { evaluation: record, session: updated, readinessReport };
}

export async function getSession(userId: string, sessionId: string): Promise<InterviewSessionDoc | null> {
  const snap = await sessionsCol(userId).doc(sessionId).get();
  if (!snap.exists) return null;
  return snap.data() as InterviewSessionDoc;
}

export async function listSessions(userId: string, limit = 30): Promise<InterviewSessionDoc[]> {
  const snap = await sessionsCol(userId).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data() as InterviewSessionDoc);
}
