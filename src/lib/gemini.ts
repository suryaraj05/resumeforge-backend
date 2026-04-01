import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { GeminiKBResponse } from '../types/kb';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const SYSTEM_PROMPT = `You are a resume parser. Extract structured information from the resume text provided and return ONLY a valid JSON object matching the schema exactly. Do not add any explanation, markdown, or commentary. If a field is not present in the resume, omit it entirely rather than returning null. Return only the JSON.`;

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

export async function parseResumeWithGemini(resumeText: string): Promise<GeminiKBResponse> {
  const model = genAI.getGenerativeModel({ model: MODEL });

  const prompt = `${SYSTEM_PROMPT}\n\n${SCHEMA_HINT}\n\nParse the following resume and return the JSON:\n\n${resumeText}`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  const jsonStr = extractJSON(raw);
  const parsed = JSON.parse(jsonStr);

  return validateKBResponse(parsed);
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

const VALID_EXP_TYPES = new Set(['internship', 'full-time', 'part-time', 'contract']);

function sanitizeStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => typeof v === 'string');
}

function sanitizeString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

/**
 * Validates and strips unexpected fields from a Gemini response to prevent
 * untrusted data from reaching Firestore.
 */
function validateKBResponse(raw: Record<string, unknown>): GeminiKBResponse {
  const out: GeminiKBResponse = {};

  // personal
  if (raw.personal && typeof raw.personal === 'object') {
    const p = raw.personal as Record<string, unknown>;
    const personal: GeminiKBResponse['personal'] = {};
    for (const key of ['name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'summary'] as const) {
      const v = sanitizeString(p[key]);
      if (v) personal[key] = v;
    }
    if (Object.keys(personal).length) out.personal = personal;
  }

  // education
  if (Array.isArray(raw.education)) {
    out.education = raw.education
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => ({
        id: sanitizeString(e.id) || crypto.randomUUID(),
        ...(sanitizeString(e.institution) ? { institution: sanitizeString(e.institution)! } : {}),
        ...(sanitizeString(e.degree) ? { degree: sanitizeString(e.degree)! } : {}),
        ...(sanitizeString(e.field) ? { field: sanitizeString(e.field)! } : {}),
        ...(sanitizeString(e.startDate) ? { startDate: sanitizeString(e.startDate)! } : {}),
        ...(sanitizeString(e.endDate) ? { endDate: sanitizeString(e.endDate)! } : {}),
        ...(sanitizeString(e.cgpa) ? { cgpa: sanitizeString(e.cgpa)! } : {}),
        ...(Array.isArray(e.achievements) && e.achievements.length ? { achievements: sanitizeStringArray(e.achievements) } : {}),
      }));
    if (!out.education.length) delete out.education;
  }

  // experience
  if (Array.isArray(raw.experience)) {
    out.experience = raw.experience
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((e) => ({
        id: sanitizeString(e.id) || crypto.randomUUID(),
        ...(sanitizeString(e.company) ? { company: sanitizeString(e.company)! } : {}),
        ...(sanitizeString(e.role) ? { role: sanitizeString(e.role)! } : {}),
        ...(VALID_EXP_TYPES.has(e.type as string) ? { type: e.type as 'internship' | 'full-time' | 'part-time' | 'contract' } : {}),
        ...(sanitizeString(e.startDate) ? { startDate: sanitizeString(e.startDate)! } : {}),
        ...(sanitizeString(e.endDate) ? { endDate: sanitizeString(e.endDate)! } : {}),
        ...(Array.isArray(e.description) && e.description.length ? { description: sanitizeStringArray(e.description) } : {}),
        ...(Array.isArray(e.techStack) && e.techStack.length ? { techStack: sanitizeStringArray(e.techStack) } : {}),
      }));
    if (!out.experience.length) delete out.experience;
  }

  // projects
  if (Array.isArray(raw.projects)) {
    out.projects = raw.projects
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        id: sanitizeString(p.id) || crypto.randomUUID(),
        ...(sanitizeString(p.name) ? { name: sanitizeString(p.name)! } : {}),
        ...(sanitizeString(p.description) ? { description: sanitizeString(p.description)! } : {}),
        ...(Array.isArray(p.techStack) && p.techStack.length ? { techStack: sanitizeStringArray(p.techStack) } : {}),
        ...(sanitizeString(p.link) ? { link: sanitizeString(p.link)! } : {}),
        ...(Array.isArray(p.highlights) && p.highlights.length ? { highlights: sanitizeStringArray(p.highlights) } : {}),
        ...(sanitizeString(p.date) ? { date: sanitizeString(p.date)! } : {}),
      }));
    if (!out.projects.length) delete out.projects;
  }

  // skills
  if (raw.skills && typeof raw.skills === 'object') {
    const s = raw.skills as Record<string, unknown>;
    const skills: GeminiKBResponse['skills'] = {};
    for (const key of ['technical', 'tools', 'languages', 'soft'] as const) {
      const arr = sanitizeStringArray(s[key]);
      if (arr.length) skills[key] = arr;
    }
    if (Object.keys(skills).length) out.skills = skills;
  }

  // certifications
  if (Array.isArray(raw.certifications)) {
    out.certifications = raw.certifications
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({
        id: sanitizeString(c.id) || crypto.randomUUID(),
        ...(sanitizeString(c.name) ? { name: sanitizeString(c.name)! } : {}),
        ...(sanitizeString(c.issuer) ? { issuer: sanitizeString(c.issuer)! } : {}),
        ...(sanitizeString(c.date) ? { date: sanitizeString(c.date)! } : {}),
        ...(sanitizeString(c.link) ? { link: sanitizeString(c.link)! } : {}),
      }));
    if (!out.certifications.length) delete out.certifications;
  }

  // achievements
  if (Array.isArray(raw.achievements)) {
    out.achievements = raw.achievements
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        id: sanitizeString(a.id) || crypto.randomUUID(),
        ...(sanitizeString(a.title) ? { title: sanitizeString(a.title)! } : {}),
        ...(sanitizeString(a.description) ? { description: sanitizeString(a.description)! } : {}),
        ...(sanitizeString(a.date) ? { date: sanitizeString(a.date)! } : {}),
      }));
    if (!out.achievements.length) delete out.achievements;
  }

  // publications
  if (Array.isArray(raw.publications)) {
    out.publications = raw.publications
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        id: sanitizeString(p.id) || crypto.randomUUID(),
        ...(sanitizeString(p.title) ? { title: sanitizeString(p.title)! } : {}),
        ...(sanitizeString(p.venue) ? { venue: sanitizeString(p.venue)! } : {}),
        ...(sanitizeString(p.date) ? { date: sanitizeString(p.date)! } : {}),
        ...(sanitizeString(p.link) ? { link: sanitizeString(p.link)! } : {}),
      }));
    if (!out.publications.length) delete out.publications;
  }

  return out;
}
