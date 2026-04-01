import { v4 as uuidv4 } from 'uuid';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase';
import type { ApplicationDoc, ApplicationStatus, ScoredJob } from '../types/jobs';

function col(userId: string) {
  return db.collection('users').doc(userId).collection('applications');
}

export async function createApplication(
  userId: string,
  payload: {
    job: ScoredJob;
    status?: ApplicationStatus;
    resumeJson?: unknown;
    coverLetter?: string;
    atsScore?: number;
  }
): Promise<ApplicationDoc> {
  const applicationId = uuidv4();
  const now = new Date().toISOString();
  const doc: ApplicationDoc = {
    applicationId,
    jobId: payload.job.jobId,
    jobTitle: payload.job.title,
    company: payload.job.company,
    location: payload.job.location,
    jdText: payload.job.description,
    status: payload.status ?? 'saved',
    fitScore: payload.job.score.fitScore,
    appliedDate: null,
    createdAt: now,
    updatedAt: now,
    resumeJson: payload.resumeJson as ApplicationDoc['resumeJson'],
    coverLetter: payload.coverLetter ?? null,
    atsScore: payload.atsScore ?? null,
    applyUrl: payload.job.applyUrl ?? null,
    logoUrl: payload.job.logoUrl ?? null,
  };
  await col(userId).doc(applicationId).set({
    ...doc,
    appliedDate: null,
  });
  return doc;
}

/**
 * Upsert one application row per job (keyed by jobId). New searches refresh title/JD/fit/link/logo
 * without changing status or resume artifacts the user already set.
 */
export async function upsertApplicationsFromSearch(userId: string, jobs: ScoredJob[]): Promise<void> {
  if (!jobs.length) return;
  const ref = col(userId);
  for (const job of jobs) {
    const snap = await ref.where('jobId', '==', job.jobId).limit(1).get();
    const now = new Date().toISOString();
    if (snap.empty) {
      const applicationId = uuidv4();
      await ref.doc(applicationId).set({
        applicationId,
        jobId: job.jobId,
        jobTitle: job.title,
        company: job.company,
        location: job.location,
        jdText: job.description,
        status: 'saved' as ApplicationStatus,
        fitScore: job.score.fitScore,
        appliedDate: null,
        applyUrl: job.applyUrl ?? null,
        logoUrl: job.logoUrl ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const d = snap.docs[0];
      await d.ref.update({
        jobTitle: job.title,
        company: job.company,
        location: job.location,
        jdText: job.description,
        fitScore: job.score.fitScore,
        applyUrl: job.applyUrl ?? null,
        logoUrl: job.logoUrl ?? null,
        updatedAt: now,
      });
    }
  }
}

export async function updateApplication(
  userId: string,
  applicationId: string,
  patch: Partial<{
    status: ApplicationStatus;
    notes: string;
    nextAction: string;
    interviewDate: Date | null;
    salaryOffered: string;
    resumeJson: unknown;
    coverLetter: string;
    atsScore: number;
  }>
): Promise<void> {
  const ref = col(userId).doc(applicationId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Application not found');

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };

  if (patch.status != null) {
    updates.status = patch.status;
    if (patch.status === 'applied') {
      updates.appliedDate = FieldValue.serverTimestamp();
    }
  }
  if (patch.notes != null) updates.notes = patch.notes;
  if (patch.nextAction != null) updates.nextAction = patch.nextAction;
  if (patch.salaryOffered != null) updates.salaryOffered = patch.salaryOffered;
  if (patch.resumeJson != null) updates.resumeJson = patch.resumeJson;
  if (patch.coverLetter != null) updates.coverLetter = patch.coverLetter;
  if (patch.atsScore != null) updates.atsScore = patch.atsScore;
  if (patch.interviewDate !== undefined) {
    updates.interviewDate = patch.interviewDate
      ? Timestamp.fromDate(patch.interviewDate)
      : null;
  }

  await ref.update(updates);
}

export async function deleteApplication(userId: string, applicationId: string): Promise<void> {
  await col(userId).doc(applicationId).delete();
}

export async function getApplication(
  userId: string,
  applicationId: string
): Promise<ApplicationDoc | null> {
  const snap = await col(userId).doc(applicationId).get();
  if (!snap.exists) return null;
  return snap.data() as ApplicationDoc;
}

export async function listApplicationsGrouped(userId: string): Promise<{
  byStatus: Record<ApplicationStatus, ApplicationDoc[]>;
  all: ApplicationDoc[];
}> {
  const snap = await col(userId).orderBy('updatedAt', 'desc').limit(200).get();
  const all = snap.docs.map((d) => d.data() as ApplicationDoc);
  const byStatus: Record<ApplicationStatus, ApplicationDoc[]> = {
    saved: [],
    applied: [],
    interview: [],
    offer: [],
    rejected: [],
  };
  for (const a of all) {
    if (byStatus[a.status]) byStatus[a.status].push(a);
  }
  return { byStatus, all };
}

export async function findApplicationByJobId(
  userId: string,
  jobId: string
): Promise<ApplicationDoc | null> {
  const snap = await col(userId).where('jobId', '==', jobId).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data() as ApplicationDoc;
}

export async function findApplicationByCompany(
  userId: string,
  companyFragment: string
): Promise<ApplicationDoc | null> {
  const frag = companyFragment.toLowerCase();
  const snap = await col(userId).limit(100).get();
  for (const d of snap.docs) {
    const a = d.data() as ApplicationDoc;
    if (a.company.toLowerCase().includes(frag)) return a;
  }
  return null;
}
