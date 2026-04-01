import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase';
import {
  dedupeJobs,
  fetchAdzunaJobs,
  fetchApifyIndianStartups,
  fetchJSearchJobs,
} from './jobProviders';
import { getOrInferJobProfile } from './jobProfileService';
import { scoreJobsForUser } from './jobScoringService';
import { buildWeakSpotReportFromScores } from './weakSpotsService';
import { upsertApplicationsFromSearch } from './applicationsService';
import type { JobSearchProfile, NormalizedJob, ScoredJob } from '../types/jobs';

const SEARCH_CACHE_HOURS = 6;

function searchCacheRef(userId: string, key: string) {
  return db.collection('users').doc(userId).collection('jobSearchCache').doc(key);
}

function cacheKey(params: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex')
    .slice(0, 40);
}

function mapDatePosted(filter?: string): 'all' | 'today' | '3days' | 'week' {
  if (filter === 'Last 24h') return 'today';
  if (filter === 'Last 3 days') return '3days';
  if (filter === 'Last week') return 'week';
  return 'week';
}

function mapEmployment(roleType?: string): string | undefined {
  if (roleType === 'Internship') return 'INTERN';
  if (roleType === 'Contract') return 'CONTRACTOR';
  if (roleType === 'Full-time') return 'FULLTIME';
  return undefined;
}

export interface JobSearchParams {
  query?: string;
  location?: string;
  remote?: boolean;
  datePosted?: string;
  roleType?: string;
  page?: number;
  indianStartups?: boolean;
}

export async function searchJobsForUser(
  userId: string,
  params: JobSearchParams
): Promise<{
  jobs: ScoredJob[];
  profile: JobSearchProfile;
  weakSpotReport: Awaited<ReturnType<typeof buildWeakSpotReportFromScores>>;
  fromCache: boolean;
  scoringCapped: boolean;
}> {
  const { profile } = await getOrInferJobProfile(userId);

  const query =
    (params.query && params.query.trim()) ||
    profile.searchQueries[0] ||
    profile.primaryRoles[0] ||
    'software engineer';

  const location = params.location ?? 'Remote';
  const remoteOnly = params.remote ?? location === 'Remote';
  const datePosted = mapDatePosted(params.datePosted);
  const employmentTypes = mapEmployment(params.roleType);
  const page = params.page ?? 1;

  const cacheParams = {
    query,
    location,
    remoteOnly,
    datePosted,
    employmentTypes,
    page,
    indian: params.indianStartups,
  };
  const ck = cacheKey(cacheParams);
  const cRef = searchCacheRef(userId, ck);
  const cached = await cRef.get();
  if (cached.exists) {
    const d = cached.data() as {
      jobs?: ScoredJob[];
      expiresAt?: Timestamp;
      profileSnapshot?: JobSearchProfile;
    };
    if (d.expiresAt && d.expiresAt.toMillis() > Date.now() && Array.isArray(d.jobs)) {
      return {
        jobs: d.jobs,
        profile: d.profileSnapshot ?? profile,
        weakSpotReport: null,
        fromCache: true,
        scoringCapped: false,
      };
    }
  }

  const jsearchPromise = fetchJSearchJobs({
    query:
      location === 'Indian Startups' || params.indianStartups
        ? `${query} startup`
        : query,
    page,
    remoteOnly: remoteOnly || location === 'India (Remote)',
    datePosted,
    employmentTypes,
  });

  const adzunaCountries = ['UK', 'Germany', 'Australia'];
  const adzunaPromise = adzunaCountries.includes(location)
    ? fetchAdzunaJobs({ query, locationLabel: location, page })
    : Promise.resolve([] as NormalizedJob[]);

  const apifyPromise =
    location === 'Indian Startups' || params.indianStartups
      ? fetchApifyIndianStartups(query)
      : Promise.resolve([] as NormalizedJob[]);

  const [js, ad, ap] = await Promise.all([jsearchPromise, adzunaPromise, apifyPromise]);

  let merged = dedupeJobs([...js, ...ad, ...ap]);

  if (!merged.length && !process.env.JSEARCH_API_KEY?.trim()) {
    merged = [
      {
        jobId: 'demo-local-role',
        source: 'jsearch',
        externalId: 'demo',
        title: 'Configure JSearch API',
        company: 'ResumeForge',
        location: 'Remote',
        description:
          'Add JSEARCH_API_KEY (RapidAPI) to apps/api/.env to load live listings from LinkedIn, Indeed, Glassdoor, and more. Your job profile is ready — once the key is set, refresh this search.',
        postedAt: new Date().toISOString(),
        isRemote: true,
      },
    ];
  }

  const { scored, capped } = await scoreJobsForUser(userId, profile, merged);

  const jobs: ScoredJob[] = scored
    .map(({ job, score }) => ({ ...job, score }))
    .sort((a, b) => b.score.fitScore - a.score.fitScore);

  const weakSpotReport = await buildWeakSpotReportFromScores(
    userId,
    jobs.map((j) => j.score),
    jobs.length
  );

  const expiresAt = Timestamp.fromMillis(Date.now() + SEARCH_CACHE_HOURS * 60 * 60 * 1000);
  await cRef.set({
    jobs,
    profileSnapshot: profile,
    expiresAt,
    cachedAt: new Date().toISOString(),
    params: cacheParams,
  });

  try {
    await upsertApplicationsFromSearch(userId, jobs);
  } catch (e) {
    console.warn('[jobSearch] upsertApplicationsFromSearch failed', e);
  }

  return { jobs, profile, weakSpotReport, fromCache: false, scoringCapped: capped };
}
