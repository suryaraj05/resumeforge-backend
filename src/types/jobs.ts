import type { Timestamp } from 'firebase-admin/firestore';
import type { RefinedResume } from './resume';

export interface JobSearchProfile {
  primaryRoles: string[];
  secondaryRoles: string[];
  keySkills: string[];
  seniorityLevel: 'internship' | 'entry-level' | 'mid-level';
  preferredStack: string[];
  industryPreferences: string[];
  searchQueries: string[];
  weakSpots: string[];
  kbVersionAtInference: number;
  lastInferredAt: string;
}

export interface JobScoreResult {
  fitScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  whyThisRole: string;
  startupSignals: string;
  salaryFit: boolean;
  applyUrgency: 'high' | 'medium' | 'low';
}

export interface NormalizedJob {
  jobId: string;
  source: 'jsearch' | 'adzuna' | 'apify';
  externalId: string;
  title: string;
  company: string;
  location: string;
  description: string;
  postedAt?: string;
  salary?: string;
  applyUrl?: string;
  /** Direct logo URL from provider (e.g. JSearch employer_logo) — avoids third-party logo CDNs. */
  logoUrl?: string;
  isRemote?: boolean;
  companyDomain?: string;
}

export interface ScoredJob extends NormalizedJob {
  score: JobScoreResult;
}

export interface WeakSpotReport {
  topGaps: {
    skill: string;
    appearsInJobs: number;
    estimatedImpact: string;
    learningTimeEstimate: string;
  }[];
  summary: string;
  generatedAt: string;
  fromJobCount: number;
}

export type ApplicationStatus = 'saved' | 'applied' | 'interview' | 'offer' | 'rejected';

export interface ApplicationDoc {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location: string;
  jdText: string;
  status: ApplicationStatus;
  fitScore: number;
  appliedDate: Timestamp | null;
  applyUrl?: string | null;
  logoUrl?: string | null;
  resumeJson?: RefinedResume | null;
  coverLetter?: string | null;
  atsScore?: number | null;
  notes?: string;
  nextAction?: string;
  interviewDate?: Timestamp | null;
  salaryOffered?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type InterviewMode = 'chat_qa' | 'timed_mock';
export type InterviewFocus = 'technical' | 'behavioral' | 'mixed';

export interface InterviewQuestionItem {
  id: number;
  type: string;
  difficulty: string;
  question: string;
  hints: string[];
  followUp: string;
}

export interface InterviewAnswerRecord {
  questionId: number;
  answer: string;
  score?: number;
  strengths?: string[];
  improvements?: string[];
  modelAnswer?: string;
  askedFollowUp?: boolean;
  followUpAnswer?: string;
}

export interface ReadinessReport {
  company: string;
  role: string;
  date: string;
  overallScore: number;
  readinessLevel: 'Not ready' | 'Needs work' | 'Almost there' | 'Interview ready';
  strongestArea: string;
  weakestArea: string;
  suggestions: string[];
  questionBreakdown: { question: string; score: number; type: string }[];
}

export interface CompanyIntel {
  interviewStyle: string;
  commonQuestions: string[];
  cultureFit: string;
  redFlags: string;
  insiderTip: string;
}

export interface InterviewSessionDoc {
  sessionId: string;
  userId: string;
  applicationId?: string | null;
  company: string;
  role: string;
  jdText: string;
  mode: InterviewMode;
  focus: InterviewFocus;
  companyIntel?: CompanyIntel | null;
  questions: InterviewQuestionItem[];
  answers: InterviewAnswerRecord[];
  currentQuestionIndex: number;
  awaitingFollowUpFor?: number | null;
  readinessReport?: ReadinessReport | null;
  complete: boolean;
  createdAt: string;
  updatedAt: string;
}
