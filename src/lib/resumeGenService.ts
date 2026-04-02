import { getGeminiModelId } from './geminiModels';
import { nextGoogleGenerativeAI } from './geminiKeys';
import { KnowledgeBase } from '../types/kb';
import {
  RefinedResume,
  ATSScoreResult,
  JobFitResult,
} from '../types/resume';

const LONG_MS = 60_000;
/** Long-form resume JSON can be large; allow a slower, higher-token generation. */
const CURATOR_MS = 120_000;
const CURATOR_MAX_OUTPUT_TOKENS = 16_384;

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
  const model = nextGoogleGenerativeAI().getGenerativeModel({ model: getGeminiModelId() });
  const result = await withTimeout(model.generateContent(prompt), ms);
  return result.response.text().trim();
}

async function geminiTextCurator(prompt: string): Promise<string> {
  const model = nextGoogleGenerativeAI().getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: {
      maxOutputTokens: CURATOR_MAX_OUTPUT_TOKENS,
      temperature: 0.35,
    },
  });
  const result = await withTimeout(model.generateContent(prompt), CURATOR_MS);
  return result.response.text().trim();
}

const CURATOR_SYSTEM = `You are a professional resume curator. You will receive a user's complete knowledge base and a job description.

OUTPUT SHAPE: LONG-FORM (approximately 2–4 pages when printed). Do NOT optimize for a single page. The user wants depth and completeness, not minimalism.

Your task:
1) Score each experience bullet, project, skill, and achievement for relevance to the job description (1–10).
2) INCLUDE almost everything that is relevant (score ≥5) or plausibly transferable. Only omit items that are clearly unrelated to the role, duplicated, or empty. Do NOT cut material just to save space.
3) For each retained job / experience entry: include 4–10 accomplishment bullets when the KB provides enough substance; merge or split KB lines as needed. If the KB only has short notes, expand into strong STAR-style bullets using ONLY truthful details from the KB (no invented employers, dates, metrics, or degrees).
4) For each retained project: set "name", optional "date", "techStack" array, optional "description", and "highlights" with 3–8 bullets each when the KB supports it.
5) Skills: populate technical, tools, languages, and soft arrays generously from the KB; group and dedupe lightly but prefer inclusion over a tiny keyword list.
6) Summary: write a substantive professional summary (about 120–220 words unless the profile is very thin), tightly aligned to the JD.
7) Education: include every education entry from the KB with degree, institution, dates, field, cgpa when present.
8) Include certifications and achievements from the KB that relate to the role (or are impressive generally).
9) Rewrite wording to mirror the JD's vocabulary where honest to do so.

STRICT JSON TYPES: experience[].description, project[].highlights, project[].techStack, and skills.technical/tools/languages/soft must be arrays of plain strings only (never objects or nested structures). Same for all scalar fields (title, name, role, etc.): use strings only.

Return ONLY a JSON object with this structure: { "targetRole": string, "summary": string, "education": array, "experience": array, "projects": array, "skills": object, "certifications": array, "achievements": array, "reasoning": { "included": [{ "item": string, "reason": string }], "excluded": [{ "item": string, "reason": string }] } }.
In "reasoning.excluded", list only items you truly left out and why (irrelevant/duplicate/unsupported), not items you shortened for length.

Do not add explanation or markdown outside the JSON.`;

export async function generateRefinedResume(
  kb: KnowledgeBase,
  jd: string
): Promise<RefinedResume> {
  const prompt = `${CURATOR_SYSTEM}

Job Description:
${jd}

User's Full Knowledge Base:
${JSON.stringify(kb, null, 2)}`;

  const raw = await geminiTextCurator(prompt);
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
