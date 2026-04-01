import * as admin from 'firebase-admin';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from apps/api (dev) or cwd (deploy)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function normalizeServiceAccountJsonString(raw: string): string {
  let s = raw.trim();
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1).trim();
  }
  return s;
}

function getAdminCredential(): admin.ServiceAccount {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonRaw) {
    const json = normalizeServiceAccountJsonString(jsonRaw);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const projectId = String(parsed.project_id ?? parsed.projectId ?? '');
      const clientEmail = String(parsed.client_email ?? parsed.clientEmail ?? '');
      let privateKey = String(parsed.private_key ?? parsed.privateKey ?? '');
      privateKey = privateKey.replace(/\\n/g, '\n');
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must include project_id, client_email, private_key');
      }
      return { projectId, clientEmail, privateKey };
    } catch (e) {
      const hint =
        'Use valid JSON (double quotes on every key). One line in .env, or delete this var and set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY instead.';
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${e instanceof Error ? e.message : 'parse error'}. ${hint}`
      );
    }
  }

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin is not configured. Create apps/api/.env with either:\n' +
        '  • FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}\n' +
        '    (single line JSON from your service account key file)\n' +
        '  OR the three variables:\n' +
        '  • FIREBASE_ADMIN_PROJECT_ID\n' +
        '  • FIREBASE_ADMIN_CLIENT_EMAIL\n' +
        '  • FIREBASE_ADMIN_PRIVATE_KEY (use \\n for newlines in .env)\n' +
        'Also set FIREBASE_STORAGE_BUCKET (e.g. podnotes-eed71.firebasestorage.app).'
    );
  }

  return { projectId, clientEmail, privateKey };
}

if (!admin.apps.length) {
  const cred = getAdminCredential();
  admin.initializeApp({
    credential: admin.credential.cert(cred),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const firestore = admin.firestore();
// Job listings include optional fields (salary, applyUrl, …) that are often undefined;
// Firestore rejects undefined unless stripped.
try {
  firestore.settings({ ignoreUndefinedProperties: true });
} catch {
  /* already applied (e.g. dev hot reload) */
}

export const db = firestore;
export const auth = admin.auth();
export const storage = admin.storage();
export default admin;
