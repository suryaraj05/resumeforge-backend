import { createHash } from 'crypto';
import type { NormalizedJob } from '../types/jobs';

function stableJobId(source: string, externalId: string): string {
  return createHash('sha256')
    .update(`${source}:${externalId}`)
    .digest('hex')
    .slice(0, 32);
}

function guessDomainFromCompany(company: string): string | undefined {
  const c = company.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (c.length < 2) return undefined;
  return `${c}.com`;
}

interface JSearchRow {
  job_id?: string;
  employer_name?: string;
  employer_logo?: string;
  employer_website?: string;
  job_title?: string;
  job_city?: string;
  job_country?: string;
  job_description?: string;
  job_posted_at_datetime_utc?: string;
  job_min_salary?: number;
  job_max_salary?: number;
  job_salary_currency?: string;
  job_salary_period?: string;
  job_apply_link?: string;
  job_is_remote?: boolean;
}

interface JSearchResponse {
  data?: JSearchRow[];
}

export async function fetchJSearchJobs(params: {
  query: string;
  page?: number;
  remoteOnly?: boolean;
  datePosted?: 'all' | 'today' | '3days' | 'week';
  employmentTypes?: string;
}): Promise<NormalizedJob[]> {
  const key = process.env.JSEARCH_API_KEY?.trim();
  if (!key) return [];

  const url = new URL('https://jsearch.p.rapidapi.com/search');
  url.searchParams.set('query', params.query);
  url.searchParams.set('page', String(params.page ?? 1));
  url.searchParams.set('num_pages', '1');
  if (params.remoteOnly) url.searchParams.set('remote_jobs_only', 'true');
  if (params.datePosted && params.datePosted !== 'all') {
    url.searchParams.set('date_posted', params.datePosted);
  }
  if (params.employmentTypes) {
    url.searchParams.set('employment_types', params.employmentTypes);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
    },
  });

  if (!res.ok) {
    console.warn('[JSearch] HTTP', res.status, await res.text().catch(() => ''));
    return [];
  }

  const json = (await res.json()) as JSearchResponse;
  const rows = json.data ?? [];

  return rows.map((r) => {
    const ext = String(r.job_id ?? `${r.employer_name}-${r.job_title}`);
    const company = String(r.employer_name ?? 'Company');
    let domain: string | undefined;
    if (r.employer_website) {
      try {
        domain = new URL(
          r.employer_website.startsWith('http') ? r.employer_website : `https://${r.employer_website}`
        ).hostname.replace(/^www\./, '');
      } catch {
        domain = guessDomainFromCompany(company);
      }
    } else {
      domain = guessDomainFromCompany(company);
    }

    const min = r.job_min_salary;
    const max = r.job_max_salary;
    const cur = r.job_salary_currency ?? '';
    let salary: string | undefined;
    if (min != null && max != null) salary = `${cur} ${min}–${max} (${r.job_salary_period ?? 'yr'})`;
    else if (min != null) salary = `${cur} ${min}+`;

    const loc = [r.job_city, r.job_country].filter(Boolean).join(', ');

    const rawLogo = r.employer_logo?.trim();
    let logoUrl: string | undefined;
    if (rawLogo && /^https?:\/\//i.test(rawLogo)) {
      logoUrl = rawLogo;
    }

    return {
      jobId: stableJobId('jsearch', ext),
      source: 'jsearch' as const,
      externalId: ext,
      title: String(r.job_title ?? 'Role'),
      company,
      location: loc || '—',
      description: String(r.job_description ?? '').slice(0, 12000),
      postedAt: r.job_posted_at_datetime_utc,
      salary,
      applyUrl: r.job_apply_link,
      logoUrl,
      isRemote: Boolean(r.job_is_remote),
      companyDomain: domain,
    };
  });
}

interface AdzunaResult {
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  company?: { display_name?: string };
  location?: { display_name?: string };
  id?: string | number;
}

interface AdzunaResponse {
  results?: AdzunaResult[];
}

const ADZUNA_COUNTRY_MAP: Record<string, string> = {
  UK: 'gb',
  USA: 'us',
  Germany: 'de',
  Australia: 'au',
  India: 'in',
};

export async function fetchAdzunaJobs(params: {
  query: string;
  locationLabel: string;
  page?: number;
}): Promise<NormalizedJob[]> {
  const appId = process.env.ADZUNA_APP_ID?.trim();
  const appKey = process.env.ADZUNA_APP_KEY?.trim();
  if (!appId || !appKey) return [];

  const country =
    ADZUNA_COUNTRY_MAP[params.locationLabel] ??
    (params.locationLabel.toLowerCase().includes('uk') ? 'gb' : '');

  if (!country) return [];

  const url = new URL(
    `https://api.adzuna.com/v1/api/jobs/${country}/search/${params.page ?? 1}`
  );
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', '15');
  url.searchParams.set('what', params.query);
  if (params.locationLabel && !['Remote', 'USA', 'UK'].includes(params.locationLabel)) {
    url.searchParams.set('where', params.locationLabel);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.warn('[Adzuna] HTTP', res.status);
    return [];
  }

  const json = (await res.json()) as AdzunaResponse;
  const results = json.results ?? [];

  return results.map((r) => {
    const company = String(r.company?.display_name ?? 'Company');
    const ext = String(r.id ?? `${company}-${r.title}`);
    const min = r.salary_min;
    const max = r.salary_max;
    let salary: string | undefined;
    if (min != null && max != null) salary = `${min}–${max}`;
    return {
      jobId: stableJobId('adzuna', ext),
      source: 'adzuna' as const,
      externalId: ext,
      title: String(r.title ?? 'Role'),
      company,
      location: String(r.location?.display_name ?? '—'),
      description: String(r.description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 12000),
      postedAt: r.created,
      salary,
      applyUrl: r.redirect_url,
      isRemote: /remote/i.test(String(r.title) + String(r.description)),
      companyDomain: guessDomainFromCompany(company),
    };
  });
}

/** Placeholder: Apify Wellfound runs are optional; returns [] without token. */
export async function fetchApifyIndianStartups(_query: string): Promise<NormalizedJob[]> {
  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) return [];
  // On-demand actor runs require actor ID + run sync API — omitted to avoid blocking; extend when actor is configured.
  return [];
}

export function dedupeJobs(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  const out: NormalizedJob[] = [];
  for (const j of jobs) {
    const k = `${j.company.toLowerCase()}::${j.title.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(j);
  }
  return out;
}
