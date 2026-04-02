/**
 * Gemini model discovery: ordered candidates, ListModels API merge, probe via generateContent.
 *
 * Run probe (from apps/api):  npm run gemini:probe
 * Prints which model IDs work with your Gemini API key and suggests GEMINI_MODEL=...
 */
import dotenv from 'dotenv';
import { getFirstGeminiApiKey } from './geminiKeys';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Models we try first for chat, resume parsing, and PDF (text + multimodal).
 * Only includes IDs that typically work for new API keys (see npm run gemini:probe).
 * Omitted on purpose: gemini-2.0-* / gemini-1.5-* (often 404 for new users), preview-05-20, TTS/image-only, Gemma, Lyria, etc.
 */
export const GEMINI_MODEL_CANDIDATES: string[] = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-pro-latest',
];

export const GEMINI_MODEL_DEFAULT_FALLBACK = 'gemini-2.5-flash';

export function getGeminiModelId(): string {
  return (process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT_FALLBACK).trim();
}

export interface GeminiProbeRow {
  model: string;
  ok: boolean;
  httpStatus: number;
  detail: string;
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, body };
}

async function postJson(url: string, payload: object): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, body };
}

/** List model IDs that advertise generateContent (paginated). */
export async function listGenerativeModelIds(apiKey: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ key: apiKey });
    if (pageToken) q.set('pageToken', pageToken);
    const { status, body } = await fetchJson(`${API_ROOT}/models?${q.toString()}`);
    if (status !== 200 || !body || typeof body !== 'object') break;
    const b = body as { models?: unknown[]; nextPageToken?: string };
    const models = Array.isArray(b.models) ? b.models : [];
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const rec = m as { name?: string; supportedGenerationMethods?: string[] };
      const methods = rec.supportedGenerationMethods ?? [];
      if (!methods.includes('generateContent')) continue;
      const name = rec.name ?? '';
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      if (id && !out.includes(id)) out.push(id);
    }
    pageToken = typeof b.nextPageToken === 'string' ? b.nextPageToken : undefined;
  } while (pageToken);
  return out;
}

/** One minimal generateContent; 404 = bad id, 429 = id ok but quota. */
export async function probeGenerateContent(
  apiKey: string,
  modelId: string
): Promise<{ ok: boolean; httpStatus: number; detail: string }> {
  const url = `${API_ROOT}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { status, body } = await postJson(url, {
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
    generationConfig: { maxOutputTokens: 8 },
  });
  if (status === 200) return { ok: true, httpStatus: status, detail: 'generateContent succeeded' };
  const err = body as { error?: { message?: string; code?: number; status?: string } };
  const msg = err?.error?.message ?? JSON.stringify(body).slice(0, 200);
  if (status === 429) return { ok: true, httpStatus: status, detail: `Quota/rate limit (model exists): ${msg}` };
  return { ok: false, httpStatus: status, detail: msg };
}

function sortIdsByPreference(ids: string[]): string[] {
  const idx = (id: string) => {
    const i = GEMINI_MODEL_CANDIDATES.indexOf(id);
    return i === -1 ? 1000 + id.localeCompare('') : i;
  };
  return [...ids].sort((a, b) => idx(a) - idx(b));
}

/** Skip non–general-chat models from ListModels tail (warmup only; full probe lists everything). */
function listedModelAllowedForResumeForge(id: string): boolean {
  const lower = id.toLowerCase();
  if (!lower.startsWith('gemini-')) return false;
  if (lower.includes('lyria')) return false;
  if (lower.includes('nano-banana')) return false;
  if (lower.includes('robotics-er')) return false;
  if (lower.includes('-tts') || lower.includes('preview-tts')) return false;
  if (lower.includes('computer-use')) return false;
  if (lower.includes('deep-research')) return false;
  if (lower.includes('clip-preview')) return false;
  if (lower.includes('-image-preview') || lower.endsWith('-image')) return false;
  return true;
}

export type BuildProbeOrderOptions = { filterListedForApp?: boolean };

/** Unique ordered list: preferred env model, then candidates, then remaining from API. */
export async function buildProbeOrder(
  apiKey: string,
  prefer?: string,
  opts?: BuildProbeOrderOptions
): Promise<string[]> {
  const listed = await listGenerativeModelIds(apiKey);
  const listedSorted = sortIdsByPreference(listed);
  const listedTail =
    opts?.filterListedForApp === true
      ? listedSorted.filter(listedModelAllowedForResumeForge)
      : listedSorted;
  const seen = new Set<string>();
  const order: string[] = [];
  const push = (id: string) => {
    const t = id.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    order.push(t);
  };
  if (prefer) push(prefer);
  for (const id of GEMINI_MODEL_CANDIDATES) push(id);
  for (const id of listedTail) push(id);
  return order;
}

export async function pickFirstWorkingGeminiModel(
  apiKey: string,
  prefer?: string
): Promise<string | null> {
  const order = await buildProbeOrder(apiKey, prefer, { filterListedForApp: true });
  for (const id of order) {
    const r = await probeGenerateContent(apiKey, id);
    if (r.ok) return id;
  }
  return null;
}

/** Call once at API startup: sets process.env.GEMINI_MODEL to the first working id. */
export async function warmGeminiModelSelection(): Promise<void> {
  const key = getFirstGeminiApiKey()?.trim();
  if (!key) {
    console.warn(
      '[geminiModels] No Gemini API keys — set GEMINI_API_KEYS (or GEMINI_API_KEY) in .env.',
    );
    return;
  }
  const explicit = process.env.GEMINI_MODEL?.trim();
  const chosen = await pickFirstWorkingGeminiModel(key, explicit || undefined);
  if (chosen) {
    process.env.GEMINI_MODEL = chosen;
    if (explicit && explicit !== chosen) {
      console.warn(`[geminiModels] GEMINI_MODEL=${explicit} failed probe; using ${chosen} instead.`);
    } else {
      console.log(`[geminiModels] Using ${chosen}`);
    }
  } else {
    console.warn(
      '[geminiModels] No model responded OK. Set GEMINI_MODEL manually. Run: npm run gemini:probe',
    );
  }
}

/** Full table for CLI: every id we would try, with result. */
export async function runFullGeminiProbe(apiKey: string, prefer?: string): Promise<GeminiProbeRow[]> {
  const order = await buildProbeOrder(apiKey, prefer);
  const rows: GeminiProbeRow[] = [];
  for (const model of order) {
    const r = await probeGenerateContent(apiKey, model);
    rows.push({
      model,
      ok: r.ok,
      httpStatus: r.httpStatus,
      detail: r.detail,
    });
  }
  return rows;
}

export async function printGeminiModelProbeReport(): Promise<void> {
  dotenv.config();
  const key = getFirstGeminiApiKey()?.trim();
  if (!key) {
    console.error('Set GEMINI_API_KEYS or GEMINI_API_KEY in apps/api/.env first.');
    process.exitCode = 1;
    return;
  }
  const prefer = process.env.GEMINI_MODEL?.trim();
  console.log('Listing models from Google (generateContent-capable)…');
  const listed = await listGenerativeModelIds(key);
  console.log(`Found ${listed.length} listable generateContent models.\n`);
  console.log('Probing candidates (this may take a minute)…\n');

  const rows = await runFullGeminiProbe(key, prefer || undefined);
  const okRows = rows.filter((r) => r.ok);

  console.log('--- Results (ok = usable; 429 still counts as ok: model exists) ---');
  console.table(
    rows.map((r) => ({
      model: r.model,
      ok: r.ok ? 'yes' : 'no',
      http: r.httpStatus,
      detail: r.detail.slice(0, 120) + (r.detail.length > 120 ? '…' : ''),
    }))
  );

  if (okRows.length) {
    const best = okRows[0];
    console.log('\nRecommended (first working in probe order):');
    console.log(`  GEMINI_MODEL=${best.model}`);
  } else {
    console.log('\nNo working model found. Check API key, billing, and https://ai.google.dev/gemini-api/docs/models');
  }
}

const runProbeCli =
  process.argv.includes('--probe') &&
  process.argv.some((a) => a.replace(/\\/g, '/').endsWith('/lib/geminiModels.ts') || a.endsWith('geminiModels.ts'));
if (runProbeCli) {
  void printGeminiModelProbeReport().then(() => process.exit(process.exitCode ?? 0));
}
