/** Canonical KB section names (Firestore / API). */
export const KB_SECTIONS = [
  'personal',
  'education',
  'experience',
  'projects',
  'skills',
  'certifications',
  'achievements',
  'publications',
] as const;

export type KBSectionName = (typeof KB_SECTIONS)[number];

const CANONICAL = new Set<string>(KB_SECTIONS);

/** Sections stored as arrays of items with optional `id`. */
export const KB_ARRAY_SECTIONS = new Set<KBSectionName>([
  'education',
  'experience',
  'projects',
  'certifications',
  'achievements',
  'publications',
]);

/** Aliases from intent router / user wording → canonical key */
const ALIASES: Record<string, KBSectionName> = {
  profile: 'personal',
  bio: 'personal',
  summary: 'personal',
  contact: 'personal',
  work: 'experience',
  jobs: 'experience',
  'work experience': 'experience',
  employment: 'experience',
  school: 'education',
  university: 'education',
  degree: 'education',
  tech: 'skills',
  'technical skills': 'skills',
  certs: 'certifications',
  certification: 'certifications',
  awards: 'achievements',
  pubs: 'publications',
};

/**
 * Returns canonical section name or null if unknown.
 */
export function normalizeKbSection(raw: string | undefined | null): KBSectionName | null {
  if (raw == null) return null;
  const k = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return null;
  if (CANONICAL.has(k)) return k as KBSectionName;
  if (ALIASES[k]) return ALIASES[k];
  return null;
}
