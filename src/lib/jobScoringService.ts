import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase';
import { getGeminiModelId } from './geminiModels';
import type { JobSearchProfile, JobScoreResult, NormalizedJob } from '../types/jobs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const CACHE_COLLECTION = 'jobScoreCache';
const TTL_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 50;
const USAGE_DOC = 'usage';

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

function cacheDocId(userId: string, jobId: string): string {
  return `${userId}__${jobId}`;
}

export async function getCachedScore(
  userId: string,
  jobId: string
): Promise<JobScoreResult | null> {
  const ref = db.collection(CACHE_COLLECTION).doc(cacheDocId(userId, jobId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const d = snap.data() as { score?: JobScoreResult; expiresAt?: Timestamp };
  if (!d.score || !d.expiresAt) return null;
  if (d.expiresAt.toMillis() < Date.now()) return null;
  return d.score;
}

export async function setCachedScore(
  userId: string,
  jobId: string,
  score: JobScoreResult
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.collection(CACHE_COLLECTION).doc(cacheDocId(userId, jobId)).set({
    userId,
    jobId,
    score,
    expiresAt,
  });
}

async function incrementScoreUsage(userId: string, delta: number): Promise<{ ok: boolean; remaining: number }> {
  const ref = db.collection('users').doc(userId).collection('meta').doc(USAGE_DOC);
  const today = new Date().toISOString().slice(0, 10);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.data() as { jobScoreDay?: string; jobScoreCount?: number } | undefined;
    let count = data?.jobScoreCount ?? 0;
    let day = data?.jobScoreDay ?? today;
    if (day !== today) {
      count = 0;
      day = today;
    }
    if (count + delta > DAILY_CAP) {
      return { ok: false, remaining: Math.max(0, DAILY_CAP - count) };
    }
    txn.set(
      ref,
      {
        jobScoreDay: day,
        jobScoreCount: count + delta,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    return { ok: true, remaining: DAILY_CAP - count - delta };
  });
}

function normalizeScore(raw: Partial<JobScoreResult>): JobScoreResult {
  let fit = Number(raw.fitScore);
  if (Number.isNaN(fit)) fit = 50;
  fit = Math.min(100, Math.max(0, fit));
  const urgency = raw.applyUrgency === 'high' || raw.applyUrgency === 'low' ? raw.applyUrgency : 'medium';
  return {
    fitScore: fit,
    matchedSkills: Array.isArray(raw.matchedSkills) ? raw.matchedSkills.map(String) : [],
    missingSkills: Array.isArray(raw.missingSkills) ? raw.missingSkills.map(String) : [],
    whyThisRole: String(raw.whyThisRole ?? ''),
    startupSignals: String(raw.startupSignals ?? ''),
    salaryFit: Boolean(raw.salaryFit),
    applyUrgency: urgency,
  };
}

async function scoreBatchWithGemini(
  profile: JobSearchProfile,
  jobs: NormalizedJob[]
): Promise<JobScoreResult[]> {
  const model = genAI.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: { responseMimeType: 'application/json' },
  });

  const jobSummaries = jobs.map((j) => ({
    jobId: j.jobId,
    title: j.title,
    company: j.company,
    location: j.location,
    description: j.description.slice(0, 4000),
    posted: j.postedAt ?? '',
    salary: j.salary ?? '',
  }));

  const system = `You are a hiring manager and career advisor. For EACH job in the input array, score fit against the user's job profile. Return ONLY JSON: { "scores": [ { "jobId": string, "fitScore": number (0-100), "matchedSkills": [string], "missingSkills": [string], "whyThisRole": string (1 sentence), "startupSignals": string, "salaryFit": boolean (true if salary seems compatible with strong tech roles e.g. 10LPA+ India or global equivalent), "applyUrgency": "high" | "medium" | "low" } ] } with the SAME length and order as input jobs. Do not add markdown.`;

  const user = `User's job profile:\n${JSON.stringify(profile)}\n\nJobs:\n${JSON.stringify(jobSummaries)}`;

  const result = await model.generateContent(`${system}\n\n${user}`);
  const raw = result.response.text().trim();
  const parsed = JSON.parse(extractJSON(raw)) as { scores?: Record<string, unknown>[] };
  const arr = parsed.scores ?? [];

  return jobs.map((j, i) => {
    const row = arr[i] as Record<string, unknown> | undefined;
    if (row && String(row.jobId) === j.jobId) {
      return normalizeScore(row as Partial<JobScoreResult>);
    }
    const anyRow = arr.find((x) => String((x as { jobId?: string }).jobId) === j.jobId);
    if (anyRow) return normalizeScore(anyRow as Partial<JobScoreResult>);
    return normalizeScore({ fitScore: 50, whyThisRole: 'Fit could not be scored precisely.', matchedSkills: [], missingSkills: [] });
  });
}

export async function scoreJobsForUser(
  userId: string,
  profile: JobSearchProfile,
  jobs: NormalizedJob[]
): Promise<{ scored: { job: NormalizedJob; score: JobScoreResult }[]; capped: boolean; remainingCap: number }> {
  const needNew: NormalizedJob[] = [];
  const cached: { job: NormalizedJob; score: JobScoreResult }[] = [];

  for (const j of jobs) {
    const c = await getCachedScore(userId, j.jobId);
    if (c) cached.push({ job: j, score: c });
    else needNew.push(j);
  }

  if (!needNew.length) {
    return { scored: cached, capped: false, remainingCap: DAILY_CAP };
  }

  const usage = await incrementScoreUsage(userId, needNew.length);
  if (!usage.ok) {
    const fallbackScores = needNew.map((j) => ({
      job: j,
      score: normalizeScore({
        fitScore: 50,
        whyThisRole: 'Daily AI scoring limit reached — open Jobs page tomorrow or refresh profile.',
        matchedSkills: profile.keySkills.slice(0, 3),
        missingSkills: [],
        applyUrgency: 'low',
      }),
    }));
    return {
      scored: [...cached, ...fallbackScores],
      capped: true,
      remainingCap: usage.remaining,
    };
  }

  if (!process.env.GEMINI_API_KEY?.trim()) {
    const naive = needNew.map((j) => ({
      job: j,
      score: normalizeScore({
        fitScore: 55,
        whyThisRole: 'Configure GEMINI_API_KEY for personalized fit scores.',
        matchedSkills: profile.keySkills.slice(0, 2),
        missingSkills: [],
      }),
    }));
    return { scored: [...cached, ...naive], capped: false, remainingCap: usage.remaining };
  }

  const batches: NormalizedJob[][] = [];
  for (let i = 0; i < needNew.length; i += 5) {
    batches.push(needNew.slice(i, i + 5));
  }

  const newScored: { job: NormalizedJob; score: JobScoreResult }[] = [];

  for (const batch of batches) {
    try {
      const scores = await scoreBatchWithGemini(profile, batch);
      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        const score = scores[i] ?? normalizeScore({});
        await setCachedScore(userId, job.jobId, score);
        newScored.push({ job, score });
      }
    } catch (e) {
      console.error('[jobScoring] batch failed', e);
      for (const job of batch) {
        const score = normalizeScore({ fitScore: 45, whyThisRole: 'Scoring temporarily unavailable.' });
        newScored.push({ job, score });
      }
    }
  }

  return { scored: [...cached, ...newScored], capped: false, remainingCap: usage.remaining };
}

/** Roll back usage counter if we reserved too many (not used if we commit increment before work — current design commits first; acceptable). */
