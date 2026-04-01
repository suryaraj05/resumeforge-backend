import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/firebase';
import { AuthRequest } from './verifyToken';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_CALLS = 20;

/**
 * Gemini rate limiter — max 20 AI calls per user per hour.
 * Stored in Firestore: users/{uid}/session/rateLimits.geminiCalls[]
 * Uses an array of timestamps, pruned on each check.
 */
export async function geminiRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const uid = req.uid;
  if (!uid) { next(); return; }

  try {
    const ref = db.collection('users').doc(uid).collection('session').doc('rateLimits');
    const snap = await ref.get();
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const existing: number[] = Array.isArray(snap.data()?.geminiCalls)
      ? (snap.data()!.geminiCalls as number[])
      : [];

    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= MAX_CALLS) {
      res.status(429).json({
        error: "You've been thinking a lot today! Try again in a little while.",
      });
      return;
    }

    // Record this call (non-blocking)
    ref.set({ geminiCalls: [...recent, now] }, { merge: true }).catch(() => {});

    next();
  } catch {
    // If rate limit check fails, allow the request through (fail open)
    next();
  }
}
