import type { RefinedResume, ATSScoreResult, JobFitResult } from './resume';
import type { PeerComparisonResult } from './groups';

export type ChatRole = 'user' | 'bot';

export type ChatIntent =
  | 'update_kb'
  | 'ask_kb'
  | 'generate_resume'
  | 'upload_resume'
  | 'group_create'
  | 'group_add_member'
  | 'group_update'
  | 'peer_compare'
  | 'share_profile'
  | 'ats_check'
  | 'cover_letter'
  | 'job_fit'
  | 'roast_resume'
  | 'interview_prep'
  | 'chitchat';

export interface StoredChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  intent?: ChatIntent;
  timestamp: string;
}

/** Structured follow-up from the client (skips intent routing). */
export type ChatContinuation =
  | {
      type: 'group_update_pick';
      groupId: string;
      description: string;
      section: string;
    }
  | {
      type: 'peer_compare_pick';
      groupId: string;
      targetRole: string;
    };

export interface IntentRouterResult {
  intent: ChatIntent;
  params: Record<string, string>;
  reply: string;
}

export interface InterviewQuestion {
  q: string;
  hint: string;
}

export interface KBPatchResult {
  patch: unknown;
  summary: string;
}

export interface ChatResponseData {
  // update_kb
  section?: string;
  patch?: unknown;
  patchSummary?: string;
  currentSection?: unknown;
  // interview_prep
  questions?: InterviewQuestion[];
  // suggested follow-up chips
  suggestions?: string[];
  // flags
  showUpload?: boolean;
  isRoast?: boolean;
  // Phase 4 — resume / ATS / cover letter / job fit
  refinedResume?: RefinedResume;
  reasoning?: RefinedResume['reasoning'];
  atsScore?: ATSScoreResult;
  jd?: string;
  coverLetterText?: string;
  jobFit?: JobFitResult;
  // Phase 5 — groups / public profile
  groupId?: string;
  groupName?: string;
  invitePick?: {
    targetUserId: string;
    groups: { groupId: string; name: string }[];
  };
  adminGroupChoices?: { groupId: string; name: string }[];
  bulkDescription?: string;
  bulkSection?: string;
  groupBulk?: {
    phase: 'pick_members' | 'preview';
    groupId: string;
    groupName: string;
    description: string;
    section: string;
    members: { userId: string; label: string }[];
    patches?: {
      userId: string;
      displayLabel: string;
      section: string;
      patch: unknown;
      currentSection: unknown;
      summary: string;
    }[];
  };
  peerComparePickGroup?: {
    targetRole: string;
    groups: { groupId: string; name: string }[];
  };
  peerComparison?: PeerComparisonResult;
  publicProfileUrl?: string;
}

export interface ChatResponse {
  intent: ChatIntent;
  reply: string;
  data?: ChatResponseData;
}
