import { v4 as uuidv4 } from 'uuid';
import { db } from './firebase';
import type { StoredChatMessage } from '../types/chat';

export const CHAT_MESSAGES_CAP = 100;
const CHAT_SESSIONS_CAP = 60;
const DEFAULT_SESSION_TITLE = 'New chat';

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatSessionDoc {
  title: string;
  createdAt: string;
  updatedAt: string;
}

function sessionsCol(uid: string) {
  return db.collection('users').doc(uid).collection('chatSessions');
}

function messagesCol(uid: string, sessionId: string) {
  return sessionsCol(uid).doc(sessionId).collection('messages');
}

async function deleteSessionMessages(uid: string, sessionId: string): Promise<void> {
  const snap = await messagesCol(uid, sessionIdLimit(sessionId)).get();
  const chunks: typeof snap.docs[] = [];
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    chunks.push(docs.slice(i, i + 400));
  }
  for (const part of chunks) {
    const batch = db.batch();
    part.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

function sessionIdLimit(id: string): string {
  const t = id?.trim();
  if (!t) throw new Error('sessionId is required');
  return t;
}

/**
 * One-time migration: flat chatHistory collection becomes one session + messages subcollection.
 */
export async function migrateLegacyChatHistoryIfNeeded(uid: string): Promise<void> {
  const anySession = await sessionsCol(uid).limit(1).get();
  if (!anySession.empty) return;

  const legacy = await db
    .collection('users')
    .doc(uid)
    .collection('chatHistory')
    .orderBy('timestamp', 'asc')
    .get();

  if (legacy.empty) return;

  const sessionId = uuidv4();
  const firstUser = legacy.docs.map((d) => d.data() as StoredChatMessage).find((m) => m.role === 'user');
  let title = DEFAULT_SESSION_TITLE;
  if (firstUser?.content?.trim()) {
    const line = firstUser.content.trim().split(/\n/)[0] ?? '';
    title = line.length > 56 ? `${line.slice(0, 53)}…` : line || DEFAULT_SESSION_TITLE;
  } else {
    title = 'Imported chat';
  }

  const lastTs =
    (legacy.docs[legacy.docs.length - 1]?.data() as StoredChatMessage)?.timestamp ??
    new Date().toISOString();
  const now = new Date().toISOString();

  await sessionsCol(uid).doc(sessionId).set({
    title,
    createdAt: now,
    updatedAt: lastTs,
  } satisfies ChatSessionDoc);

  const msgRef = messagesCol(uid, sessionId);
  const writeBatch = db.batch();
  legacy.docs.forEach((d) => {
    writeBatch.set(msgRef.doc(d.id), d.data());
  });
  await writeBatch.commit();

  for (let i = 0; i < legacy.docs.length; i += 400) {
    const b = db.batch();
    legacy.docs.slice(i, i + 400).forEach((doc) => b.delete(doc.ref));
    await b.commit();
  }
}

async function pruneExcessSessions(uid: string): Promise<void> {
  const snap = await sessionsCol(uid).orderBy('updatedAt', 'asc').get();
  if (snap.size <= CHAT_SESSIONS_CAP) return;
  const overflow = snap.docs.slice(0, snap.size - CHAT_SESSIONS_CAP);
  for (const d of overflow) {
    await deleteChatSession(uid, d.id);
  }
}

export async function listChatSessions(uid: string): Promise<ChatSessionSummary[]> {
  await migrateLegacyChatHistoryIfNeeded(uid);
  const snap = await sessionsCol(uid).orderBy('updatedAt', 'desc').get();
  return snap.docs.map((d) => {
    const data = d.data() as ChatSessionDoc;
    return {
      id: d.id,
      title: data.title ?? DEFAULT_SESSION_TITLE,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    };
  });
}

export async function createChatSession(
  uid: string,
  title = DEFAULT_SESSION_TITLE
): Promise<ChatSessionSummary> {
  await migrateLegacyChatHistoryIfNeeded(uid);
  const id = uuidv4();
  const now = new Date().toISOString();
  await sessionsCol(uid).doc(id).set({
    title: title.trim() || DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
  } satisfies ChatSessionDoc);
  await pruneExcessSessions(uid);
  return { id, title: title.trim() || DEFAULT_SESSION_TITLE, createdAt: now, updatedAt: now };
}

export async function updateChatSessionTitle(
  uid: string,
  sessionId: string,
  title: string
): Promise<void> {
  const sid = sessionIdLimit(sessionId);
  const ref = sessionsCol(uid).doc(sid);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Session not found');
  await ref.update({
    title: title.trim() || DEFAULT_SESSION_TITLE,
    updatedAt: new Date().toISOString(),
  });
}

export async function maybeAutoTitleFromFirstMessage(
  uid: string,
  sessionId: string,
  userMessage: string
): Promise<void> {
  const sid = sessionIdLimit(sessionId);
  const ref = sessionsCol(uid).doc(sid);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() as ChatSessionDoc;
  if (data.title !== DEFAULT_SESSION_TITLE) return;
  const line = userMessage.trim().split(/\n/)[0] ?? '';
  if (!line.trim()) return;
  const title = line.length > 56 ? `${line.slice(0, 53)}…` : line;
  await ref.update({ title, updatedAt: new Date().toISOString() });
}

export async function deleteChatSession(uid: string, sessionId: string): Promise<void> {
  const sid = sessionIdLimit(sessionId);
  await deleteSessionMessages(uid, sid);
  await sessionsCol(uid).doc(sid).delete();
}

export async function clearAllChatData(uid: string): Promise<void> {
  const sessions = await sessionsCol(uid).get();
  for (const d of sessions.docs) {
    await deleteSessionMessages(uid, d.id);
    await d.ref.delete();
  }
  const legacy = await db.collection('users').doc(uid).collection('chatHistory').get();
  if (legacy.size) {
    for (let i = 0; i < legacy.docs.length; i += 400) {
      const b = db.batch();
      legacy.docs.slice(i, i + 400).forEach((doc) => b.delete(doc.ref));
      await b.commit();
    }
  }
}

export async function getSessionMessages(
  uid: string,
  sessionId: string
): Promise<StoredChatMessage[]> {
  await migrateLegacyChatHistoryIfNeeded(uid);
  const sid = sessionIdLimit(sessionId);
  const sess = await sessionsCol(uid).doc(sid).get();
  if (!sess.exists) throw new Error('Session not found');
  const snap = await messagesCol(uid, sid).orderBy('timestamp', 'asc').limit(CHAT_MESSAGES_CAP).get();
  return snap.docs.map((d) => d.data() as StoredChatMessage);
}

export async function appendSessionMessages(
  uid: string,
  sessionId: string,
  messages: StoredChatMessage[]
): Promise<void> {
  const sid = sessionIdLimit(sessionId);
  const sess = await sessionsCol(uid).doc(sid).get();
  if (!sess.exists) throw new Error('Session not found');

  const col = messagesCol(uid, sid);
  const batch = db.batch();
  messages.forEach((msg) => {
    batch.set(col.doc(msg.id), msg);
  });
  await batch.commit();

  const lastTs = messages[messages.length - 1]?.timestamp ?? new Date().toISOString();
  await sessionsCol(uid).doc(sid).update({ updatedAt: lastTs });

  pruneSessionMessagesAsync(uid, sid);
}

async function pruneSessionMessagesAsync(uid: string, sessionId: string): Promise<void> {
  try {
    const col = messagesCol(uid, sessionId);
    const all = await col.orderBy('timestamp', 'asc').get();
    if (all.size > CHAT_MESSAGES_CAP) {
      const toDelete = all.docs.slice(0, all.size - CHAT_MESSAGES_CAP);
      const batch = db.batch();
      toDelete.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.error('[pruneSessionMessagesAsync]', err);
  }
}
