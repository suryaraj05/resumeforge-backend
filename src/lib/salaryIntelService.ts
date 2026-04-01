import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase';

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // company+role cache — spec said per combo; use 7d to save SerpAPI

function docId(company: string, role: string): string {
  return createHash('sha256')
    .update(`${company.toLowerCase()}::${role.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

export interface SalaryIntelResult {
  snippet: string;
  source: 'serpapi' | 'none';
  cachedAt: string;
}

export async function getSalaryIntel(
  company: string,
  role: string
): Promise<SalaryIntelResult> {
  const key = docId(company, role);
  const ref = db.collection('salaryCache').doc(key);
  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data() as { snippet?: string; expiresAt?: Timestamp };
    if (d.snippet && d.expiresAt && d.expiresAt.toMillis() > Date.now()) {
      return { snippet: d.snippet, source: 'serpapi', cachedAt: snap.updateTime?.toDate().toISOString() ?? '' };
    }
  }

  const apiKey = process.env.SERPAPI_KEY?.trim();
  if (!apiKey) {
    return {
      snippet: 'Salary intelligence unavailable (set SERPAPI_KEY for Levels.fyi search results).',
      source: 'none',
      cachedAt: new Date().toISOString(),
    };
  }

  const q = `site:levels.fyi ${company} ${role} salary`;
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', q);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', '3');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      return { snippet: 'Salary lookup failed.', source: 'none', cachedAt: new Date().toISOString() };
    }
    const json = (await res.json()) as {
      organic_results?: { snippet?: string; title?: string }[];
    };
    const org = json.organic_results ?? [];
    const snippet = org
      .map((o) => `${o.title ?? ''}: ${o.snippet ?? ''}`.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' \n');

    const text = snippet || 'No Levels.fyi snippets found for this query.';
    const expiresAt = Timestamp.fromMillis(Date.now() + TTL_MS);
    await ref.set({
      company,
      role,
      snippet: text,
      expiresAt,
      updatedAt: new Date().toISOString(),
    });

    return { snippet: text, source: 'serpapi', cachedAt: new Date().toISOString() };
  } catch (e) {
    console.warn('[salaryIntel]', e);
    return { snippet: 'Salary lookup error.', source: 'none', cachedAt: new Date().toISOString() };
  }
}
