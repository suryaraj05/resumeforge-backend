import { GoogleGenerativeAI } from '@google/generative-ai';
import { KnowledgeBase } from '../types/kb';
import {
  RefinedResume,
  ATSScoreResult,
  JobFitResult,
} from '../types/resume';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const LONG_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    ),
  ]);
}

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

async function geminiText(prompt: string, ms = LONG_MS): Promise<string> {
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await withTimeout(model.generateContent(prompt), ms);
  return result.response.text().trim();
}

const CURATOR_SYSTEM = `You are a professional resume curator. You will receive a user's complete knowledge base and a job description. Your task is to: 1) Score each experience bullet, project, skill, and achievement for relevance to the job description (1-10). 2) Select the highest-scoring items that fit within a one-page resume. 3) Rewrite selected bullet points to align with the JD's language while staying truthful. 4) Return ONLY a JSON object with this structure: { "targetRole": string, "summary": string, "education": array, "experience": array, "projects": array, "skills": object, "certifications": array, "achievements": array, "reasoning": { "included": [{ "item": string, "reason": string }], "excluded": [{ "item": string, "reason": string }] } }. Do not add explanation or markdown.`;

export async function generateRefinedResume(
  kb: KnowledgeBase,
  jd: string
): Promise<RefinedResume> {
  const prompt = `${CURATOR_SYSTEM}

Job Description:
${jd}

User's Full Knowledge Base:
${JSON.stringify(kb, null, 2)}`;

  const raw = await geminiText(prompt);
  const parsed = JSON.parse(extractJSON(raw)) as RefinedResume;
  return parsed;
}

const ATS_SYSTEM = `You are an ATS (Applicant Tracking System) expert. Given a job description and a refined resume JSON, evaluate the resume for ATS compatibility. Return ONLY a JSON object: { "score": number (0-100), "missingKeywords": [string], "presentKeywords": [string], "suggestions": [string (max 5 actionable suggestions)] }. Do not add explanation or markdown.`;

export async function scoreATS(jd: string, resumeJson: RefinedResume): Promise<ATSScoreResult> {
  const prompt = `${ATS_SYSTEM}

Job Description:
${jd}

Resume JSON:
${JSON.stringify(resumeJson, null, 2)}`;

  const raw = await geminiText(prompt, 45_000);
  const parsed = JSON.parse(extractJSON(raw)) as ATSScoreResult;
  return {
    score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
    missingKeywords: Array.isArray(parsed.missingKeywords) ? parsed.missingKeywords.map(String) : [],
    presentKeywords: Array.isArray(parsed.presentKeywords) ? parsed.presentKeywords.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String).slice(0, 5) : [],
  };
}

const COVER_SYSTEM = `You are a professional cover letter writer. Given a user's refined resume JSON and a job description, write a compelling, personalized cover letter. Keep it to 3 paragraphs: opening hook + relevant experience highlight, specific skills/projects relevant to JD, closing with enthusiasm. Tone: professional but not robotic. Return ONLY the cover letter text, no subject line, no salutation beyond "Dear Hiring Manager,".`;

export async function generateCoverLetter(
  jd: string,
  resumeJson: RefinedResume
): Promise<string> {
  const prompt = `${COVER_SYSTEM}

Job Description:
${jd}

Resume JSON:
${JSON.stringify(resumeJson, null, 2)}`;

  const text = await geminiText(prompt, 45_000);
  return text.replace(/^```[\s\S]*?```$/m, '').trim();
}

const FIT_SYSTEM = `You are a hiring manager evaluating a candidate. Given a job description and a user's knowledge base, provide a job fit assessment. Return ONLY a JSON: { "overallFit": number (0-100), "strengths": [string (max 3)], "gaps": [string (max 3)], "verdict": string (1 sentence summary) }.`;

export async function assessJobFit(jd: string, kb: KnowledgeBase): Promise<JobFitResult> {
  const prompt = `${FIT_SYSTEM}

Job Description:
${jd}

Knowledge Base:
${JSON.stringify(kb, null, 2)}`;

  const raw = await geminiText(prompt, 45_000);
  const parsed = JSON.parse(extractJSON(raw)) as JobFitResult;
  return {
    overallFit: Math.min(100, Math.max(0, Number(parsed.overallFit) || 0)),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String).slice(0, 3) : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String).slice(0, 3) : [],
    verdict: String(parsed.verdict || ''),
  };
}
