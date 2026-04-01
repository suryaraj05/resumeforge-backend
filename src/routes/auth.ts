import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { db } from '../lib/firebase';
import {
  suggestDefaultUsername,
  isValidUsername,
  reserveUsername,
  usernameAvailable,
} from '../lib/usernameService';

const router = Router();

/**
 * POST /api/auth/onboard
 * Called after first-time sign-up to create the Firestore user document.
 */
router.post('/onboard', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { displayName, email, username: requestedUsername } = req.body;
    const uid = req.uid!;

    const userRef = db.collection('users').doc(uid);
    const existing = await userRef.get();

    if (existing.exists) {
      res.status(200).json({ message: 'User already onboarded', alreadyExists: true });
      return;
    }

    let username = typeof requestedUsername === 'string' && isValidUsername(requestedUsername.toLowerCase())
      ? requestedUsername.toLowerCase()
      : suggestDefaultUsername(displayName || email || 'user', uid);

    if (!(await usernameAvailable(username, uid))) {
      username = suggestDefaultUsername(`${displayName || 'u'}${uid.slice(0, 4)}`, uid);
      let n = 0;
      while (!(await usernameAvailable(username, uid)) && n < 20) {
        username = `${username.slice(0, 20)}${n}`;
        n += 1;
      }
    }
    await reserveUsername(username, uid);

    await userRef.set({
      displayName: displayName || '',
      email: email || '',
      username,
      profilePublic: true,
      allowAnonymousComparison: false,
      showContactOnProfile: false,
      createdAt: new Date().toISOString(),
      onboarded: false,
    });

    res.status(201).json({ message: 'User created', uid, username });
  } catch (error) {
    console.error('[POST /auth/onboard]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 * Returns the current user's Firestore document.
 */
router.get('/me', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ uid, ...userDoc.data() });
  } catch (error) {
    console.error('[GET /auth/me]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
