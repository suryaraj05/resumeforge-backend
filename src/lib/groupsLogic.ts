import { db } from './firebase';
import { getKB } from './kbService';
import { GroupDoc, GroupMember, NotificationDoc } from '../types/groups';
import { anonymizeKBForPeer, runPeerComparison } from './groupPatchGemini';

export async function listGroupsForUser(userId: string): Promise<GroupDoc[]> {
  const snap = await db.collection('groups').get();
  const out: GroupDoc[] = [];
  snap.docs.forEach((d) => {
    const g = d.data() as GroupDoc;
    if (g.members?.some((m) => m.userId === userId)) {
      out.push({ ...g, groupId: d.id });
    }
  });
  return out;
}

export function isAdminOf(group: GroupDoc, userId: string): boolean {
  return group.members.some((m) => m.userId === userId && m.role === 'admin');
}

export async function listAdminGroups(userId: string): Promise<GroupDoc[]> {
  const all = await listGroupsForUser(userId);
  return all.filter((g) => isAdminOf(g, userId));
}

export async function getGroupById(groupId: string): Promise<GroupDoc | null> {
  const snap = await db.collection('groups').doc(groupId).get();
  if (!snap.exists) return null;
  return { ...(snap.data() as GroupDoc), groupId };
}

/**
 * POST-like helper: join a group directly using its ID.
 * This is used for "join group <groupId>" UX and for users that already have the group ID.
 */
export async function joinGroupById(
  userId: string,
  groupId: string
): Promise<{ ok: true; groupName: string } | { ok: false; error: string }> {
  const group = await getGroupById(groupId);
  if (!group) return { ok: false, error: 'Group not found' };

  if (group.members?.some((m) => m.userId === userId)) {
    return { ok: true, groupName: group.name };
  }

  const now = new Date().toISOString();
  const newMembers: GroupMember[] = [
    ...(group.members ?? []),
    { userId, role: 'member', joinedAt: now },
  ];

  await db.collection('groups').doc(groupId).update({ members: newMembers });
  return { ok: true, groupName: group.name };
}

export async function sendGroupInvite(
  fromUserId: string,
  groupId: string,
  targetUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const gSnap = await db.collection('groups').doc(groupId).get();
  if (!gSnap.exists) return { ok: false, error: 'Group not found' };
  const group = gSnap.data() as GroupDoc;
  if (!group.members.some((m) => m.userId === fromUserId)) {
    return { ok: false, error: 'Not a member' };
  }
  if (group.members.some((m) => m.userId === targetUserId)) {
    return { ok: false, error: 'Already a member' };
  }
  const fromDoc = await db.collection('users').doc(fromUserId).get();
  const notifRef = db.collection('users').doc(targetUserId).collection('notifications').doc();
  const notif: Omit<NotificationDoc, 'id'> = {
    type: 'group_invite',
    groupId,
    groupName: group.name,
    fromUserId,
    fromDisplayName: (fromDoc.data()?.displayName as string) || 'Someone',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await notifRef.set(notif);
  return { ok: true };
}

export async function createGroup(creatorId: string, name: string): Promise<GroupDoc> {
  const ref = db.collection('groups').doc();
  const groupId = ref.id;
  const now = new Date().toISOString();
  const members: GroupMember[] = [{ userId: creatorId, role: 'admin', joinedAt: now }];
  const doc: GroupDoc = {
    groupId,
    name: name.trim().slice(0, 80),
    createdBy: creatorId,
    members,
    createdAt: now,
  };
  await ref.set(doc);
  return doc;
}

export async function peerCompareInGroup(
  userId: string,
  groupId: string,
  targetRole: string
): Promise<Awaited<ReturnType<typeof runPeerComparison>>> {
  const group = await getGroupById(groupId);
  if (!group || !group.members.some((m) => m.userId === userId)) {
    throw new Error('NOT_MEMBER');
  }
  const userKb = await getKB(userId);
  if (!userKb) throw new Error('NO_KB');

  const peerKbs: Record<string, unknown>[] = [];
  let idx = 0;
  for (const m of group.members) {
    if (m.userId === userId) continue;
    const uDoc = await db.collection('users').doc(m.userId).get();
    const settings = uDoc.data() as { allowAnonymousComparison?: boolean } | undefined;
    if (!settings?.allowAnonymousComparison) continue;
    const kb = await getKB(m.userId);
    if (!kb) continue;
    peerKbs.push(anonymizeKBForPeer(kb, idx++));
  }
  if (!peerKbs.length) throw new Error('NO_PEERS');
  return runPeerComparison(userKb, peerKbs, targetRole);
}
