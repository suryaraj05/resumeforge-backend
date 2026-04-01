import { Router, Response, Request } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { db } from '../lib/firebase';
import { getKB, updateKBSection, rollbackKB, getKBHistory, writeKB } from '../lib/kbService';
import { sanitizeGeminiKbResponse, kbHasMinimumContent } from '../lib/kbSanitize';
import { buildPublicProfile } from '../lib/publicProfileBuilder';
import {
  isValidUsername,
  reserveUsername,
  releaseUsername,
  usernameAvailable,
} from '../lib/usernameService';
import { NotificationDoc } from '../types/groups';

const router = Router();

/**
 * GET /api/profile/public/:username — no auth (SEO / share links)
 */
router.get('/public/:username', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username } = req.params;
    const key = username.toLowerCase();
    const mapSnap = await db.collection('usernames').doc(key).get();
    if (!mapSnap.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const userId = (mapSnap.data() as { userId?: string }).userId;
    if (!userId) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    const user = userDoc.data() as {
      displayName?: string;
      profilePublic?: boolean;
      showContactOnProfile?: boolean;
    };
    if (user.profilePublic === false) {
      res.status(404).json({ error: 'This profile is private' });
      return;
    }
    const kb = await getKB(userId);
    const payload = buildPublicProfile(
      key,
      user.displayName || 'Member',
      kb,
      Boolean(user.showContactOnProfile)
    );
    res.json(payload);
  } catch (err) {
    console.error('[GET /profile/public/:username]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile
 */
router.get('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    res.json({ uid, ...userDoc.data() });
  } catch (error) {
    console.error('[GET /profile]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/profile
 */
router.patch('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { displayName, onboarded } = req.body;
    const updates: Record<string, unknown> = {};
    if (displayName !== undefined) updates.displayName = String(displayName);
    if (onboarded !== undefined) updates.onboarded = Boolean(onboarded);
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }
    await db.collection('users').doc(uid).update(updates);
    res.json({ message: 'Profile updated' });
  } catch (error) {
    console.error('[PATCH /profile]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/kb
 */
router.get('/kb', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const kb = await getKB(req.uid!);
    if (!kb) {
      res.status(404).json({ error: 'No knowledge base found' });
      return;
    }
    res.json(kb);
  } catch (error) {
    console.error('[GET /profile/kb]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profile/kb/import
 * Body: { json: string } — raw JSON from an external LLM (or { payload: object }).
 * Strips userId, lastUpdated, version if present; sanitizes and replaces KB.
 */
router.post('/kb/import', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { json, payload } = req.body as { json?: unknown; payload?: unknown };
    let parsed: unknown;
    if (typeof json === 'string') {
      try {
        parsed = JSON.parse(json.trim());
      } catch {
        res.status(400).json({ error: 'Invalid JSON string' });
        return;
      }
    } else if (payload !== undefined && typeof payload === 'object' && payload !== null) {
      parsed = payload;
    } else {
      res.status(400).json({ error: 'Send { json: "<stringified object>" } or { payload: { ... } }' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      res.status(400).json({ error: 'JSON must be a single object, not an array' });
      return;
    }
    const record = { ...(parsed as Record<string, unknown>) };
    delete record.userId;
    delete record.lastUpdated;
    delete record.version;

    const patch = sanitizeGeminiKbResponse(record);
    if (!kbHasMinimumContent(patch)) {
      res.status(422).json({
        error:
          'After validation, not enough profile data remained. Include at least a name, or education, experience, projects, or skills.',
      });
      return;
    }
    const kb = await writeKB(req.uid!, patch, 'Imported from pasted JSON');
    res.json({ kb });
  } catch (error) {
    console.error('[POST /profile/kb/import]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profile/kb/update
 * Accepts { section, patch, summary }. Validates and applies a section-level KB patch.
 */
router.post('/kb/update', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { section, patch, summary } = req.body as {
      section: string;
      patch: unknown;
      summary?: string;
    };

    if (!section || patch === undefined) {
      res.status(400).json({ error: 'section and patch are required' });
      return;
    }

    const validSections = ['personal', 'education', 'experience', 'projects', 'skills', 'certifications', 'achievements', 'publications'];
    if (!validSections.includes(section)) {
      res.status(400).json({ error: `Invalid section: ${section}` });
      return;
    }

    const kb = await updateKBSection(req.uid!, section, patch, summary);
    res.json({ kb });
  } catch (error) {
    console.error('[POST /profile/kb/update]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/kb/history
 */
router.get('/kb/history', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const history = await getKBHistory(req.uid!);
    res.json({ history });
  } catch (error) {
    console.error('[GET /profile/kb/history]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profile/kb/rollback
 * Accepts { timestamp }. Restores KB to the version saved at that timestamp.
 */
/**
 * GET /api/profile/notifications
 */
router.get('/notifications', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const snap = await db
      .collection('users')
      .doc(req.uid!)
      .collection('notifications')
      .limit(25)
      .get();
    const notifications = snap.docs
      .map((d) => ({
        id: d.id,
        ...(d.data() as Omit<NotificationDoc, 'id'>),
      }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ notifications });
  } catch (err) {
    console.error('[GET /profile/notifications]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profile/settings
 * { username?, profilePublic?, allowAnonymousComparison?, showContactOnProfile? }
 */
router.put('/settings', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { username, profilePublic, allowAnonymousComparison, showContactOnProfile } = req.body as {
      username?: string;
      profilePublic?: boolean;
      allowAnonymousComparison?: boolean;
      showContactOnProfile?: boolean;
    };

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const current = userSnap.data() as {
      username?: string;
      profilePublic?: boolean;
      allowAnonymousComparison?: boolean;
      showContactOnProfile?: boolean;
    };

    if (username !== undefined) {
      const u = String(username).toLowerCase().trim();
      if (!isValidUsername(u)) {
        res.status(400).json({ error: 'Username must be 3-30 chars: lowercase letters, numbers, underscore' });
        return;
      }
      const avail = await usernameAvailable(u, uid);
      if (!avail) {
        res.status(409).json({ error: 'Username is taken' });
        return;
      }
      if (current.username && current.username !== u) {
        await releaseUsername(current.username, uid);
      }
      await reserveUsername(u, uid);
      await userRef.update({ username: u });
    }

    const updates: Record<string, unknown> = {};
    if (profilePublic !== undefined) updates.profilePublic = Boolean(profilePublic);
    if (allowAnonymousComparison !== undefined) {
      updates.allowAnonymousComparison = Boolean(allowAnonymousComparison);
    }
    if (showContactOnProfile !== undefined) {
      updates.showContactOnProfile = Boolean(showContactOnProfile);
    }
    if (Object.keys(updates).length) {
      await userRef.update(updates);
    }

    const fresh = await userRef.get();
    res.json({ ...fresh.data(), uid });
  } catch (err) {
    console.error('[PUT /profile/settings]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/kb/rollback', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { timestamp } = req.body as { timestamp: string };
    if (!timestamp) {
      res.status(400).json({ error: 'timestamp is required' });
      return;
    }
    const kb = await rollbackKB(req.uid!, timestamp);
    res.json({ kb, message: `Rolled back to ${timestamp}` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Internal server error';
    console.error('[POST /profile/kb/rollback]', error);
    res.status(msg.includes('No history') ? 404 : 500).json({ error: msg });
  }
});

/**
 * GET /api/profile/activity
 * Returns the user's KB version history formatted as an activity feed.
 */
router.get('/activity', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const history = await getKBHistory(req.uid!);
    const feed = history.map((h) => ({
      timestamp: h.lastUpdated,
      summary: h.changeSummary || 'Knowledge base updated',
      version: h.version,
    }));
    res.json({ feed });
  } catch (err) {
    console.error('[GET /profile/activity]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profile/notifications/mark-read
 * { ids?: string[] } — marks specific or all notifications as read.
 */
router.post('/notifications/mark-read', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ids } = req.body as { ids?: string[] };
    const uid = req.uid!;
    const col = db.collection('users').doc(uid).collection('notifications');

    if (ids && Array.isArray(ids) && ids.length) {
      const batch = db.batch();
      ids.forEach((id) => batch.update(col.doc(id), { read: true }));
      await batch.commit();
    } else {
      const snap = await col.where('read', '!=', true).get();
      if (snap.size) {
        const batch = db.batch();
        snap.docs.forEach((d) => batch.update(d.ref, { read: true }));
        await batch.commit();
      }
    }
    res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('[POST /profile/notifications/mark-read]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/profile/account
 * Danger zone — deletes user's Firestore data (not Firebase Auth record).
 */
router.delete('/account', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const userRef = db.collection('users').doc(uid);

    // Delete sub-collections
    const collections = [
      'knowledgeBase',
      'chatHistory',
      'session',
      'notifications',
      'jobProfile',
      'applications',
      'interviewSessions',
      'jobSearchCache',
      'jobWeakSpots',
      'meta',
    ];
    for (const col of collections) {
      const snap = await userRef.collection(col).get();
      if (snap.size) {
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }

    // Release username if set
    const snap = await userRef.get();
    const username = snap.data()?.username as string | undefined;
    if (username) {
      await db.collection('usernames').doc(username.toLowerCase()).delete();
    }

    await userRef.delete();
    res.json({ message: 'Account data deleted' });
  } catch (err) {
    console.error('[DELETE /profile/account]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
