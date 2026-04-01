import { db } from './firebase';
import { RefinedResume, ATSScoreResult } from '../types/resume';

const DOC_PATH = 'session';
const DOC_ID = 'data';

export interface SessionData {
  jd?: string;
  latestResume?: RefinedResume;
  lastAts?: ATSScoreResult;
  lastCoverLetter?: string;
  updatedAt?: string;
}

export async function getSession(userId: string): Promise<SessionData | null> {
  const snap = await db
    .collection('users')
    .doc(userId)
    .collection(DOC_PATH)
    .doc(DOC_ID)
    .get();
  if (!snap.exists) return null;
  return snap.data() as SessionData;
}

export async function saveSession(
  userId: string,
  partial: Partial<SessionData>
): Promise<void> {
  const ref = db.collection('users').doc(userId).collection(DOC_PATH).doc(DOC_ID);
  await ref.set(
    {
      ...partial,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}
