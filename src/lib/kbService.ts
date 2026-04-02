import { db } from './firebase';
import { KnowledgeBase, GeminiKBResponse } from '../types/kb';
import { sanitizeGeminiKbResponse } from './kbSanitize';
import { KB_ARRAY_SECTIONS, type KBSectionName } from './kbSectionUtils';

const MAX_HISTORY_VERSIONS = 20;

const VALID_SECTIONS = new Set([
  'personal', 'education', 'experience', 'projects',
  'skills', 'certifications', 'achievements', 'publications',
]);

function itemId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const id = (item as Record<string, unknown>).id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}

/** Patch updates rows by id; existing rows omitted from the patch are kept. */
function mergeArraySection(current: unknown, patch: unknown): unknown {
  const oldArr = Array.isArray(current) ? [...current] : [];
  const newArr = Array.isArray(patch) ? patch : [];
  const indexById = new Map<string, number>();
  oldArr.forEach((item, i) => {
    const id = itemId(item);
    if (id) indexById.set(id, i);
  });
  const out = [...oldArr];
  for (const item of newArr) {
    const id = itemId(item);
    if (id) {
      const idx = indexById.get(id);
      if (idx !== undefined) {
        out[idx] = item;
      } else {
        out.push(item);
        indexById.set(id, out.length - 1);
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

function mergeObjectSection(current: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const oldObj =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...oldObj, ...(patch as Record<string, unknown>) };
}

function stripMeta(kb: KnowledgeBase): Record<string, unknown> {
  const { userId: _u, lastUpdated: _l, version: _v, ...rest } = kb;
  return rest as Record<string, unknown>;
}

export async function getKB(userId: string): Promise<KnowledgeBase | null> {
  const doc = await db
    .collection('users')
    .doc(userId)
    .collection('knowledgeBase')
    .doc('current')
    .get();

  if (!doc.exists) return null;
  return doc.data() as KnowledgeBase;
}

/**
 * Full KB write (used on initial resume upload).
 * Archives current version to history, increments version.
 */
export async function writeKB(
  userId: string,
  patch: GeminiKBResponse,
  changeSummary?: string
): Promise<KnowledgeBase> {
  return _writeKBInternal(userId, patch, changeSummary);
}

/**
 * Partial KB section update (used by chat KB update flow).
 * Replaces only the specified section.
 */
export async function updateKBSection(
  userId: string,
  section: string,
  patch: unknown,
  changeSummary?: string
): Promise<KnowledgeBase> {
  if (!VALID_SECTIONS.has(section)) {
    throw new Error(`Invalid KB section: ${section}`);
  }

  const current = await getKB(userId);
  const currentSection = current ? (current as unknown as Record<string, unknown>)[section] : undefined;
  let mergedSection: unknown = patch;
  if (KB_ARRAY_SECTIONS.has(section as KBSectionName)) {
    mergedSection = mergeArraySection(currentSection, patch);
  } else if (section === 'personal' || section === 'skills') {
    mergedSection = mergeObjectSection(currentSection, patch);
  }
  const base = current ? stripMeta(current) : {};
  const mergedRaw = { ...base, [section]: mergedSection };
  const sanitized = sanitizeGeminiKbResponse(mergedRaw as Record<string, unknown>);

  return _writeKBInternal(userId, sanitized, changeSummary);
}

/**
 * Restores a KB version from history.
 */
export async function rollbackKB(
  userId: string,
  timestamp: string
): Promise<KnowledgeBase> {
  const safeId = timestamp.replace(/[:.]/g, '-');
  const historyDoc = await db
    .collection('users')
    .doc(userId)
    .collection('knowledgeBase')
    .doc('history')
    .collection('versions')
    .doc(safeId)
    .get();

  if (!historyDoc.exists) {
    throw new Error(`No history entry found for timestamp: ${timestamp}`);
  }

  const historicalKB = historyDoc.data() as KnowledgeBase;
  const { userId: _u, lastUpdated: _l, version: _v, ...patch } = historicalKB;

  return _writeKBInternal(userId, patch as GeminiKBResponse, `Rolled back to version from ${timestamp}`);
}

/**
 * Returns the last 20 KB history entries with their change summaries.
 */
export async function getKBHistory(userId: string): Promise<(KnowledgeBase & { changeSummary?: string })[]> {
  const snap = await db
    .collection('users')
    .doc(userId)
    .collection('knowledgeBase')
    .doc('history')
    .collection('versions')
    .orderBy('lastUpdated', 'desc')
    .limit(MAX_HISTORY_VERSIONS)
    .get();

  return snap.docs.map((d) => d.data() as KnowledgeBase & { changeSummary?: string });
}

// ─── Internal write helper ────────────────────────────────────────────────────

async function _writeKBInternal(
  userId: string,
  patch: GeminiKBResponse,
  changeSummary?: string
): Promise<KnowledgeBase> {
  const kbRef = db
    .collection('users')
    .doc(userId)
    .collection('knowledgeBase')
    .doc('current');

  return db.runTransaction(async (txn) => {
    const currentSnap = await txn.get(kbRef);
    const now = new Date().toISOString();
    let nextVersion = 1;

    if (currentSnap.exists) {
      const current = currentSnap.data() as KnowledgeBase;
      nextVersion = (current.version || 0) + 1;

      const historyEntryRef = db
        .collection('users')
        .doc(userId)
        .collection('knowledgeBase')
        .doc('history')
        .collection('versions')
        .doc(current.lastUpdated.replace(/[:.]/g, '-'));

      txn.set(historyEntryRef, {
        ...current,
        ...(changeSummary ? { changeSummary } : {}),
      });

      pruneHistoryAsync(userId);
    }

    const newKB: KnowledgeBase = {
      ...patch,
      userId,
      lastUpdated: now,
      version: nextVersion,
    };

    txn.set(kbRef, newKB);
    return newKB;
  });
}

async function pruneHistoryAsync(userId: string): Promise<void> {
  try {
    const versionsRef = db
      .collection('users')
      .doc(userId)
      .collection('knowledgeBase')
      .doc('history')
      .collection('versions');

    const all = await versionsRef.orderBy('lastUpdated', 'asc').get();

    if (all.size > MAX_HISTORY_VERSIONS) {
      const toDelete = all.docs.slice(0, all.size - MAX_HISTORY_VERSIONS);
      const batch = db.batch();
      toDelete.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  } catch (err) {
    console.error('[pruneHistoryAsync]', err);
  }
}
