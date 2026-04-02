import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const NUMBERED_KEY_COUNT = 10;

/**
 * Collect unique Gemini API keys for load spreading (round-robin per generate call).
 *
 * Precedence:
 * 1. GEMINI_API_KEYS — comma-separated (recommended for many keys on Railway/Vercel).
 * 2. GEMINI_API_KEY_1 … GEMINI_API_KEY_10 — optional numbered vars if GEMINI_API_KEYS is empty.
 * 3. GEMINI_API_KEY — single key (backward compatible).
 */
export function getGeminiApiKeyList(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined): void => {
    const t = (raw ?? '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  const multi = process.env.GEMINI_API_KEYS?.trim();
  if (multi) {
    for (const part of multi.split(',')) push(part);
    if (out.length > 0) return out;
  }

  for (let i = 1; i <= NUMBERED_KEY_COUNT; i++) {
    push(process.env[`GEMINI_API_KEY_${i}` as keyof NodeJS.ProcessEnv] as string | undefined);
  }
  if (out.length > 0) return out;

  push(process.env.GEMINI_API_KEY);
  return out;
}

export function hasGeminiApiKeys(): boolean {
  return getGeminiApiKeyList().length > 0;
}

/** First key: model warmup / CLI probe only (not for routine traffic). */
export function getFirstGeminiApiKey(): string | undefined {
  return getGeminiApiKeyList()[0];
}

let roundRobinIndex = 0;

/** New client for the next key in rotation (call per operation, not cached at module scope). */
export function nextGoogleGenerativeAI(): GoogleGenerativeAI {
  const keys = getGeminiApiKeyList();
  if (keys.length === 0) return new GoogleGenerativeAI('');
  const i = roundRobinIndex % keys.length;
  roundRobinIndex += 1;
  return new GoogleGenerativeAI(keys[i]);
}
