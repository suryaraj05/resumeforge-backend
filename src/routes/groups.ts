import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import { db } from '../lib/firebase';
import { getKB } from '../lib/kbService';
import { updateKBSection } from '../lib/kbService';
import { GroupDoc, GroupMember, NotificationDoc } from '../types/groups';
import { generateGroupMemberPatch } from '../lib/groupPatchGemini';
import { createGroup, peerCompareInGroup } from '../lib/groupsLogic';

const router = Router();

function isAdmin(group: GroupDoc, userId: string): boolean {
  return group.members.some((m) => m.userId === userId && m.role === 'admin');
}

function memberOf(group: GroupDoc, userId: string): boolean {
  return group.members.some((m) => m.userId === userId);
}

/**
 * POST /api/groups/create
 * { name: string }
 */
router.post('/create', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name } = req.body as { name: string };
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }
    const uid = req.uid!;
    const doc = await createGroup(uid, name);
    res.status(201).json({ groupId: doc.groupId, group: doc });
  } catch (err) {
    console.error('[POST /groups/create]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/groups/bulk-update
 * Preview patches only.
 */
router.post('/bulk-update', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { groupId, memberIds, section, description } = req.body as {
      groupId: string;
      memberIds: string[];
      section: string;
      description: string;
    };
    if (!groupId || !Array.isArray(memberIds) || !memberIds.length || !section || !description) {
      res.status(400).json({ error: 'groupId, memberIds, section, and description are required' });
      return;
    }
    const validSections = ['personal', 'education', 'experience', 'projects', 'skills', 'certifications', 'achievements', 'publications'];
    if (!validSections.includes(section)) {
      res.status(400).json({ error: 'Invalid section' });
      return;
    }

    const uid = req.uid!;
    const gSnap = await db.collection('groups').doc(groupId).get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const group = gSnap.data() as GroupDoc;
    if (!isAdmin(group, uid)) {
      res.status(403).json({ error: 'Only group admins can run bulk updates' });
      return;
    }

    const memberSet = new Set(group.members.map((m) => m.userId));
    const targets = memberIds.filter((id) => memberSet.has(id));
    if (!targets.length) {
      res.status(400).json({ error: 'No valid members selected' });
      return;
    }

    const previews = await Promise.all(
      targets.map(async (memberId) => {
        const kb = await getKB(memberId);
        const currentSection = kb
          ? (kb as unknown as Record<string, unknown>)[section] ?? null
          : null;
        const patchResult = await generateGroupMemberPatch(section, currentSection, description);
        const uDoc = await db.collection('users').doc(memberId).get();
        const label = (uDoc.data()?.displayName as string) || memberId.slice(0, 8);
        return {
          userId: memberId,
          displayLabel: label,
          section: patchResult.section,
          patch: patchResult.patch,
          currentSection,
          summary: patchResult.summary,
        };
      })
    );

    res.json({ previews });
  } catch (err) {
    console.error('[POST /groups/bulk-update]', err);
    res.status(500).json({ error: 'Bulk update preview failed' });
  }
});

/**
 * POST /api/groups/bulk-update/apply
 */
router.post('/bulk-update/apply', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { groupId, updates } = req.body as {
      groupId: string;
      updates: { userId: string; section: string; patch: unknown; summary?: string }[];
    };
    if (!groupId || !Array.isArray(updates) || !updates.length) {
      res.status(400).json({ error: 'groupId and updates are required' });
      return;
    }
    const uid = req.uid!;
    const gSnap = await db.collection('groups').doc(groupId).get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const group = { ...(gSnap.data() as GroupDoc), groupId };
    if (!isAdmin(group, uid)) {
      res.status(403).json({ error: 'Only admins can apply bulk updates' });
      return;
    }
    const memberIds = new Set(group.members.map((m) => m.userId));
    for (const u of updates) {
      if (!memberIds.has(u.userId)) {
        res.status(403).json({ error: `User ${u.userId} is not in this group` });
        return;
      }
    }

    const results: { userId: string; ok: boolean }[] = [];
    for (const u of updates) {
      try {
        await updateKBSection(u.userId, u.section, u.patch, u.summary ?? 'Group bulk update');
        results.push({ userId: u.userId, ok: true });
      } catch {
        results.push({ userId: u.userId, ok: false });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('[POST /groups/bulk-update/apply]', err);
    res.status(500).json({ error: 'Apply failed' });
  }
});

/**
 * POST /api/groups/peer-compare
 * { groupId, targetRole }
 */
router.post('/peer-compare', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { groupId, targetRole } = req.body as { groupId: string; targetRole: string };
    if (!groupId || !targetRole?.trim()) {
      res.status(400).json({ error: 'groupId and targetRole are required' });
      return;
    }
    const uid = req.uid!;
    const gSnap = await db.collection('groups').doc(groupId).get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const group = gSnap.data() as GroupDoc;
    if (!memberOf(group, uid)) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    try {
      const comparison = await peerCompareInGroup(uid, groupId, targetRole.trim());
      res.json(comparison);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (code === 'NO_PEERS') {
        res.status(400).json({
          error:
            'No opted-in peers with KBs in this group. Ask members to enable comparison in profile settings.',
        });
        return;
      }
      if (code === 'NO_KB') {
        res.status(400).json({ error: 'You need a knowledge base first' });
        return;
      }
      if (code === 'NOT_MEMBER') {
        res.status(403).json({ error: 'Not a member of this group' });
        return;
      }
      throw e;
    }
  } catch (err) {
    console.error('[POST /groups/peer-compare]', err);
    res.status(500).json({ error: 'Peer comparison failed' });
  }
});

/**
 * GET /api/groups
 */
router.get('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const snap = await db.collection('groups').get();
    const mine: GroupDoc[] = [];
    snap.docs.forEach((d) => {
      const g = d.data() as GroupDoc;
      if (g.members?.some((m) => m.userId === uid)) mine.push({ ...g, groupId: d.id });
    });
    res.json({ groups: mine });
  } catch (err) {
    console.error('[GET /groups]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/groups/:groupId
 */
router.get('/:groupId', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { groupId } = req.params;
    const gSnap = await db.collection('groups').doc(groupId).get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const group = { ...(gSnap.data() as GroupDoc), groupId };
    if (!memberOf(group, uid)) {
      res.status(403).json({ error: 'Not a member' });
      return;
    }

    const membersWithKb: {
      userId: string;
      displayName: string;
      role: string;
      kbLastUpdated?: string;
    }[] = [];

    for (const m of group.members) {
      const uDoc = await db.collection('users').doc(m.userId).get();
      const kbSnap = await db
        .collection('users')
        .doc(m.userId)
        .collection('knowledgeBase')
        .doc('current')
        .get();
      membersWithKb.push({
        userId: m.userId,
        displayName: (uDoc.data()?.displayName as string) || 'Member',
        role: m.role,
        kbLastUpdated: kbSnap.exists ? (kbSnap.data() as { lastUpdated?: string })?.lastUpdated : undefined,
      });
    }

    res.json({ group, members: membersWithKb });
  } catch (err) {
    console.error('[GET /groups/:groupId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/groups/:groupId/invite
 * { targetUserId }
 */
router.post('/:groupId/invite', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { groupId } = req.params;
    const { targetUserId } = req.body as { targetUserId: string };
    if (!targetUserId) {
      res.status(400).json({ error: 'targetUserId is required' });
      return;
    }
    const gSnap = await db.collection('groups').doc(groupId).get();
    if (!gSnap.exists) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const group = gSnap.data() as GroupDoc;
    if (!memberOf(group, uid)) {
      res.status(403).json({ error: 'Not a member' });
      return;
    }
    if (group.members.some((m) => m.userId === targetUserId)) {
      res.status(400).json({ error: 'User is already in the group' });
      return;
    }

    const fromDoc = await db.collection('users').doc(uid).get();
    const notifRef = db.collection('users').doc(targetUserId).collection('notifications').doc();
    const notif: Omit<NotificationDoc, 'id'> = {
      type: 'group_invite',
      groupId,
      groupName: group.name,
      fromUserId: uid,
      fromDisplayName: (fromDoc.data()?.displayName as string) || 'Someone',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await notifRef.set(notif);
    res.status(201).json({ notificationId: notifRef.id, message: 'Invite sent' });
  } catch (err) {
    console.error('[POST /groups/:groupId/invite]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/groups/:groupId/invite/respond
 * { notificationId, accept: boolean }
 */
router.post('/:groupId/invite/respond', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.uid!;
    const { groupId } = req.params;
    const { notificationId, accept } = req.body as { notificationId: string; accept: boolean };
    if (!notificationId) {
      res.status(400).json({ error: 'notificationId is required' });
      return;
    }
    const notifRef = db.collection('users').doc(uid).collection('notifications').doc(notificationId);
    const nSnap = await notifRef.get();
    if (!nSnap.exists) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    const n = nSnap.data() as NotificationDoc;
    if (n.groupId !== groupId || n.type !== 'group_invite') {
      res.status(400).json({ error: 'Invalid notification' });
      return;
    }
    if (n.status !== 'pending') {
      res.status(400).json({ error: 'Already responded' });
      return;
    }

    if (accept) {
      const gRef = db.collection('groups').doc(groupId);
      const gSnap = await gRef.get();
      if (!gSnap.exists) {
        res.status(404).json({ error: 'Group not found' });
        return;
      }
      const group = gSnap.data() as GroupDoc;
      if (group.members.some((m) => m.userId === uid)) {
        await notifRef.update({ status: 'accepted' });
        res.json({ message: 'Already a member' });
        return;
      }
      const now = new Date().toISOString();
      const newMembers: GroupMember[] = [
        ...group.members,
        { userId: uid, role: 'member', joinedAt: now },
      ];
      await gRef.update({ members: newMembers });
      await notifRef.update({ status: 'accepted' });
      res.json({ message: 'Joined group' });
    } else {
      await notifRef.update({ status: 'declined' });
      res.json({ message: 'Declined' });
    }
  } catch (err) {
    console.error('[POST /groups/:groupId/invite/respond]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
