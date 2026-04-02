import { v4 as uuidv4 } from 'uuid';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './firebase';
import type { ApplicationDoc, ApplicationStatus, ScoredJob } from '../types/jobs';
import { getSession } from './sessionService';
import type { RefinedResume, ATSScoreResult } from '../types/resume';

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

function parseCompanyFromJd(jd: string): string | null {
  const s = jd.slice(0, 6000);
  const patterns = [
    /(?:Company|Employer)\s*[:\-]\s*([A-Za-z0-9&.,'’\- ]{2,80})/i,
    /(?:at)\s+([A-Z][A-Za-z0-9&.,'’\- ]{2,80})\s*(?:,|\(|$)/i,
    /(?:About)\s+([A-Za-z0-9&.,'’\- ]{2,80})/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m && m[1]) {
      const out = String(m[1]).trim();
      if (out.length >= 2) return out;
    }
  }
  return null;
}

function parseJobTitleFromText(jd: string, refined?: RefinedResume | null): string | null {
  if (refined?.targetRole?.trim()) return refined.targetRole.trim();
  const firstLine = jd.split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '';
  if (firstLine) {
    // Remove some common suffixes
    return firstLine.replace(/\s+-\s+(responsibilities|requirements).*/i, '').slice(0, 80) || null;
  }
  return null;
}

function parseLocationFromJd(jd: string): string | null {
  const s = jd.slice(0, 6000);
  if (/remote/i.test(s)) return 'Remote';
  const m = s.match(/(?:Location)\s*[:\-]\s*([A-Za-z0-9&.,'’\- ]{2,80})/i);
  if (m?.[1]) return String(m[1]).trim();
  return null;
}

export async function createOrUpdateApplicationFromResumeSession(
  userId: string
): Promise<{ ok: true; applicationId: string } | { ok: false; error: string }> {
  const session = await getSession(userId);
  const jd = typeof session?.jd === 'string' ? session.jd.trim() : '';
  const resumeJson = session?.latestResume as RefinedResume | undefined;
  const coverLetter = session?.lastCoverLetter ?? null;
  const ats = session?.lastAts as ATSScoreResult | undefined;

  if (!jd || jd.length < 80) {
    return { ok: false, error: 'No job description (JD) in your resume session. Generate a resume from a JD first.' };
  }
  if (!resumeJson) {
    return { ok: false, error: 'No refined resume found in your resume session.' };
  }

  const jobTitle = parseJobTitleFromText(jd, resumeJson) ?? 'Role';
  const company = parseCompanyFromJd(jd) ?? 'Company';
  const location = parseLocationFromJd(jd) ?? 'Remote';

  const existing = await findApplicationByCompany(userId, company);
  const atsScore = typeof ats?.score === 'number' ? ats.score : undefined;

  const job: ScoredJob = {
    jobId: uuidv4(),
    source: 'apify',
    externalId: uuidv4(),
    title: jobTitle,
    company,
    location,
    description: jd,
    postedAt: undefined,
    salary: undefined,
    applyUrl: undefined,
    logoUrl: undefined,
    isRemote: /remote/i.test(location),
    companyDomain: undefined,
    score: {
      fitScore: typeof atsScore === 'number' ? atsScore : 0,
      matchedSkills: [],
      missingSkills: [],
      whyThisRole: '',
      startupSignals: '',
      salaryFit: false,
      applyUrgency: 'low',
    },
  };

  if (existing?.applicationId) {
    await updateApplication(userId, existing.applicationId, {
      resumeJson,
      coverLetter: coverLetter ?? undefined,
      atsScore,
      status: 'saved',
    });
    return { ok: true, applicationId: existing.applicationId };
  }

  const created = await createApplication(userId, {
    job,
    status: 'saved',
    resumeJson,
    coverLetter: coverLetter ?? undefined,
    atsScore: atsScore ?? undefined,
  });

  return { ok: true, applicationId: created.applicationId };
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
