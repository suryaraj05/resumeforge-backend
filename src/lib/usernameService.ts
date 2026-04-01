import { db } from './firebase';

const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

export function suggestDefaultUsername(displayName: string, uid: string): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12) || 'user';
  const suffix = uid.replace(/[^a-zA-Z0-9]/g, '').slice(-4).toLowerCase() || 'x';
  let candidate = `${base}${suffix}`.slice(0, 30);
  if (candidate.length < 3) candidate = `user${suffix}`.slice(0, 30);
  return candidate;
}

export async function usernameAvailable(username: string, exceptUserId?: string): Promise<boolean> {
  const ref = db.collection('usernames').doc(username.toLowerCase());
  const snap = await ref.get();
  if (!snap.exists) return true;
  const data = snap.data() as { userId?: string };
  return exceptUserId !== undefined && data.userId === exceptUserId;
}

export async function reserveUsername(username: string, userId: string): Promise<void> {
  const key = username.toLowerCase();
  await db.collection('usernames').doc(key).set({ userId, username: key });
}

export async function releaseUsername(username: string, userId: string): Promise<void> {
  const key = username.toLowerCase();
  const ref = db.collection('usernames').doc(key);
  const snap = await ref.get();
  if (snap.exists && (snap.data() as { userId?: string }).userId === userId) {
    await ref.delete();
  }
}
