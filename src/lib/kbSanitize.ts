import { GeminiKBResponse } from '../types/kb';

const VALID_EXP_TYPES = new Set(['internship', 'full-time', 'part-time', 'contract']);

function sanitizeStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => typeof v === 'string');
}

function sanitizeString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

/**
 * Validates and strips unexpected fields from LLM / import JSON before Firestore.
 */
export function sanitizeGeminiKbResponse(raw: Record<string, unknown>): GeminiKBResponse {
  const out: GeminiKBResponse = {};

  if (raw.personal && typeof raw.personal === 'object') {
    const p = raw.personal as Record<string, unknown>;
    const personal: GeminiKBResponse['personal'] = {};
    for (const key of ['name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'summary'] as const) {
      const v = sanitizeString(p[key]);
      if (v) personal[key] = v;
    }
    if (Object.keys(personal).length) out.personal = personal;
  }

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

  if (raw.skills && typeof raw.skills === 'object') {
    const s = raw.skills as Record<string, unknown>;
    const skills: GeminiKBResponse['skills'] = {};
    for (const key of ['technical', 'tools', 'languages', 'soft'] as const) {
      const arr = sanitizeStringArray(s[key]);
      if (arr.length) skills[key] = arr;
    }
    if (Object.keys(skills).length) out.skills = skills;
  }

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

export function kbHasMinimumContent(p: GeminiKBResponse): boolean {
  if (p.personal?.name?.trim()) return true;
  if ((p.education?.length ?? 0) > 0) return true;
  if ((p.experience?.length ?? 0) > 0) return true;
  if (p.skills) {
    const s = p.skills;
    const n =
      (s.technical?.length ?? 0) +
      (s.tools?.length ?? 0) +
      (s.languages?.length ?? 0) +
      (s.soft?.length ?? 0);
    if (n > 0) return true;
  }
  if ((p.projects?.length ?? 0) > 0) return true;
  return false;
}
