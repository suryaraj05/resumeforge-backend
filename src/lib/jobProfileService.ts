import { db } from './firebase';
import { getKB } from './kbService';
import { getGeminiModelId } from './geminiModels';
import { hasGeminiApiKeys, nextGoogleGenerativeAI } from './geminiKeys';
import type { JobSearchProfile } from '../types/jobs';
import type { KnowledgeBase } from '../types/kb';

function profileRef(userId: string) {
  return db.collection('users').doc(userId).collection('jobProfile').doc('current');
}

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

function defaultProfile(kb: KnowledgeBase): JobSearchProfile {
  const skills = [
    ...(kb.skills?.technical ?? []),
    ...(kb.skills?.tools ?? []),
  ].slice(0, 8);
  const role =
    kb.experience?.[0]?.role ||
    kb.personal?.summary?.slice(0, 40) ||
    'Software Engineer';
  const q = `${role} ${skills.slice(0, 3).join(' ')}`.trim();
  return {
    primaryRoles: [role],
    secondaryRoles: ['Software Engineer', 'Developer'],
    keySkills: skills.length ? skills : ['Communication', 'Problem solving'],
    seniorityLevel: 'entry-level',
    preferredStack: (kb.skills?.technical ?? []).slice(0, 6),
    industryPreferences: [],
    searchQueries: [q, `${role} remote`, `${role} full time`].filter(Boolean).slice(0, 5),
    weakSpots: [],
    kbVersionAtInference: kb.version ?? 0,
    lastInferredAt: new Date().toISOString(),
  };
}

async function inferWithGemini(kb: KnowledgeBase): Promise<JobSearchProfile> {
  const model = nextGoogleGenerativeAI().getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: { responseMimeType: 'application/json' },
  });

  const system = `You are a career advisor. Given a user's resume knowledge base, infer their ideal job search profile. Return ONLY a JSON object: { primaryRoles: [string (max 4)], secondaryRoles: [string (max 4)], keySkills: [string (top 8)], seniorityLevel: 'internship' | 'entry-level' | 'mid-level', preferredStack: [string], industryPreferences: [string], searchQueries: [string (5 ready-to-use job search query strings optimized for job APIs)], weakSpots: [string (3-4 skills that appear frequently in target JDs but may be absent from the KB — actionable gaps)] }. Do not add explanation or markdown.`;

  const user = `User's full knowledge base:\n${JSON.stringify(kb)}`;

  const result = await model.generateContent(`${system}\n\n${user}`);
  const raw = result.response.text().trim();
  const parsed = JSON.parse(extractJSON(raw)) as Partial<JobSearchProfile>;

  return {
    primaryRoles: Array.isArray(parsed.primaryRoles) ? parsed.primaryRoles.slice(0, 4) : [],
    secondaryRoles: Array.isArray(parsed.secondaryRoles) ? parsed.secondaryRoles.slice(0, 4) : [],
    keySkills: Array.isArray(parsed.keySkills) ? parsed.keySkills.slice(0, 8) : [],
    seniorityLevel:
      parsed.seniorityLevel === 'internship' || parsed.seniorityLevel === 'mid-level'
        ? parsed.seniorityLevel
        : 'entry-level',
    preferredStack: Array.isArray(parsed.preferredStack) ? parsed.preferredStack : [],
    industryPreferences: Array.isArray(parsed.industryPreferences) ? parsed.industryPreferences : [],
    searchQueries: Array.isArray(parsed.searchQueries) ? parsed.searchQueries.slice(0, 5) : [],
    weakSpots: Array.isArray(parsed.weakSpots) ? parsed.weakSpots.slice(0, 4) : [],
    kbVersionAtInference: kb.version ?? 0,
    lastInferredAt: new Date().toISOString(),
  };
}

export async function getStoredJobProfile(userId: string): Promise<JobSearchProfile | null> {
  const snap = await profileRef(userId).get();
  if (!snap.exists) return null;
  return snap.data() as JobSearchProfile;
}

export async function saveJobProfile(userId: string, profile: JobSearchProfile): Promise<void> {
  await profileRef(userId).set(profile);
}

/**
 * Returns job profile, re-inferring from KB when missing or KB version changed.
 */
export async function getOrInferJobProfile(
  userId: string,
  options?: { force?: boolean }
): Promise<{ profile: JobSearchProfile; refreshed: boolean }> {
  const kb = await getKB(userId);
  if (!kb) {
    throw new Error('No knowledge base found');
  }

  const stored = await getStoredJobProfile(userId);
  const kbVer = kb.version ?? 0;
  const stale =
    !stored ||
    options?.force ||
    stored.kbVersionAtInference !== kbVer;

  if (!stale && stored) {
    return { profile: stored, refreshed: false };
  }

  if (!hasGeminiApiKeys()) {
    const profile = defaultProfile(kb);
    await saveJobProfile(userId, profile);
    return { profile, refreshed: true };
  }

  try {
    const profile = await inferWithGemini(kb);
    if (!profile.searchQueries?.length) {
      const fallback = defaultProfile(kb);
      Object.assign(profile, {
        searchQueries: fallback.searchQueries,
        primaryRoles: profile.primaryRoles.length ? profile.primaryRoles : fallback.primaryRoles,
      });
    }
    await saveJobProfile(userId, profile);
    return { profile, refreshed: true };
  } catch (e) {
    console.warn('[jobProfile] Gemini inference failed, using defaults:', e);
    const profile = defaultProfile(kb);
    await saveJobProfile(userId, profile);
    return { profile, refreshed: true };
  }
}
