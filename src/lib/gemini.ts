import type { GenerativeModel } from '@google/generative-ai';
import dotenv from 'dotenv';
import { GeminiKBResponse } from '../types/kb';
import { sanitizeGeminiKbResponse } from './kbSanitize';
import { getGeminiModelId } from './geminiModels';
import { nextGoogleGenerativeAI } from './geminiKeys';

dotenv.config();

type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function getModel(jsonMode: boolean): GenerativeModel {
  return nextGoogleGenerativeAI().getGenerativeModel({
    model: getGeminiModelId(),
    ...(jsonMode
      ? { generationConfig: { responseMimeType: 'application/json' as const } }
      : {}),
  });
}

function extractResponseText(result: Awaited<ReturnType<GenerativeModel['generateContent']>>): string {
  let raw: string;
  try {
    raw = result.response.text();
  } catch {
    const reason = result.response.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked the request (${reason})` : 'Gemini returned no text (empty or blocked)');
  }
  if (!raw?.trim()) {
    throw new Error('Empty response from Gemini');
  }
  return raw.trim();
}

async function parseFromParts(model: GenerativeModel, parts: ContentPart[]): Promise<GeminiKBResponse> {
  const result = await model.generateContent(parts);
  const raw = extractResponseText(result);
  const jsonStr = extractJSON(raw);
  const parsed = JSON.parse(jsonStr);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('Expected a JSON object at the top level');
  }
  return sanitizeGeminiKbResponse(parsed as Record<string, unknown>);
}

/** HTTP status on @google/generative-ai fetch failures (429 = quota / rate limit). */
export function getGeminiFetchStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}

/**
 * One `generateContent` by default (saves quota). Retry with JSON MIME only if the model returned
 * non-JSON text. Never chains a second attempt on 429 — that only wastes quota.
 */
async function parseResumeContent(parts: ContentPart[]): Promise<GeminiKBResponse> {
  let firstError: unknown;
  for (const jsonMode of [false, true] as const) {
    try {
      const model = getModel(jsonMode);
      return await parseFromParts(model, parts);
    } catch (e) {
      if (jsonMode === false) firstError = e;
      const st = getGeminiFetchStatus(e);
      if (st === 429) throw e;
      if (jsonMode === false && e instanceof SyntaxError) continue;
      throw e;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError));
}

const SYSTEM_PROMPT = `You are a resume parser. The input may come from imperfect PDF text extraction (odd line breaks, columns merged, small typos). Extract the best possible structured information anyway.

Return ONLY a valid JSON object matching the schema. No markdown, no commentary, no code fences. Omit fields that are truly absent rather than using null.

If you can identify the person's name or any jobs, education, or skills, include them even when the text is messy.`;

const SCHEMA_HINT = `
The JSON must follow this structure (all fields optional, omit missing ones entirely):
{
  "personal": { "name", "email", "phone", "location", "linkedin", "github", "portfolio", "summary" },
  "education": [{ "id"(uuid), "institution", "degree", "field", "startDate", "endDate", "cgpa", "achievements": [] }],
  "experience": [{ "id"(uuid), "company", "role", "type"(internship|full-time|part-time|contract), "startDate", "endDate", "description": [], "techStack": [] }],
  "projects": [{ "id"(uuid), "name", "description", "techStack": [], "link", "highlights": [], "date" }],
  "skills": { "technical": [], "tools": [], "languages": [], "soft": [] },
  "certifications": [{ "id"(uuid), "name", "issuer", "date", "link" }],
  "achievements": [{ "id"(uuid), "title", "description", "date" }],
  "publications": [{ "id"(uuid), "title", "venue", "date", "link" }]
}
Generate a UUID v4 for every array item "id" field.`;

const MAX_RESUME_CHARS = 75_000;

const PDF_HEAD_PROMPT = `${SYSTEM_PROMPT}\n\n${SCHEMA_HINT}\n\nThe resume is attached as a PDF. Read the document and return the JSON object described above.`;

export async function parseResumeWithGemini(resumeText: string): Promise<GeminiKBResponse> {
  const body =
    resumeText.length > MAX_RESUME_CHARS
      ? `${resumeText.slice(0, MAX_RESUME_CHARS)}\n\n[... truncated ...]`
      : resumeText;

  const prompt = `${SYSTEM_PROMPT}\n\n${SCHEMA_HINT}\n\nParse the following resume text and return the JSON:\n\n${body}`;

  return parseResumeContent([{ text: prompt }]);
}

/**
 * Multimodal fallback: Gemini reads the PDF directly (layout, columns, light graphics).
 * Prefer this when extracted text parses poorly or text-based parsing fails.
 */
export async function parseResumeWithGeminiFromPdf(pdfBuffer: Buffer): Promise<GeminiKBResponse> {
  const b64 = pdfBuffer.toString('base64');
  return parseResumeContent([
    { text: PDF_HEAD_PROMPT },
    { inlineData: { mimeType: 'application/pdf', data: b64 } },
  ]);
}

function extractJSON(raw: string): string {
  // Strip markdown code fences if Gemini wraps them anyway
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Find first { to last }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);

  return raw;
}
