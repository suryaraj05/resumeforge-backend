import { v4 as uuidv4 } from 'uuid';
import { getGeminiFetchStatus } from './gemini';
import { db } from './firebase';
import { getKB } from './kbService';
import { getSession, saveSession } from './sessionService';
import {
  generateRefinedResume,
  scoreATS,
  generateCoverLetter,
  assessJobFit,
} from './resumeGenService';
import { KnowledgeBase } from '../types/kb';
import {
  createGroup,
  listGroupsForUser,
  listAdminGroups,
  sendGroupInvite,
  joinGroupById,
  peerCompareInGroup,
} from './groupsLogic';
import {
  ChatContinuation,
  ChatIntent,
  ChatResponse,
  ChatResponseData,
  IntentRouterResult,
  InterviewQuestion,
  KBPatchResult,
  StoredChatMessage,
} from '../types/chat';

import { getGeminiModelId } from './geminiModels';
import { hasGeminiApiKeys, nextGoogleGenerativeAI } from './geminiKeys';
import { saveInterviewPrep, normalizeStoredQuestions } from './interviewPrepStorage';
import { createOrUpdateApplicationFromResumeSession } from './applicationsService';
import {
  handleJobSearchIntent,
  handleJobPrepareIntent,
  handleTrackerQueryIntent,
  handleInterviewTrainIntent,
  handleWeakSpotsIntent,
} from './jobChatHandlers';

const TIMEOUT_MS = 15000;
const LONG_TIMEOUT_MS = 130_000;
const TIMEOUT_REPLY = "I took too long to think. Could you rephrase that?";
const GEMINI_HISTORY_LIMIT = 10;

// ─── Timeout wrapper ─────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    ),
  ]);
}

function withLongTimeout<T>(promise: Promise<T>): Promise<T> {
  return withTimeout(promise, LONG_TIMEOUT_MS);
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function geminiText(prompt: string): Promise<string> {
  const model = nextGoogleGenerativeAI().getGenerativeModel({ model: getGeminiModelId() });
  const result = await withTimeout(model.generateContent(prompt));
  return result.response.text().trim();
}

// ─── KB serializer for context ───────────────────────────────────────────────

function serializeKBForContext(kb: KnowledgeBase): string {
  const lines: string[] = [];
  if (kb.personal?.name) lines.push(`Name: ${kb.personal.name}`);
  if (kb.personal?.email) lines.push(`Email: ${kb.personal.email}`);
  if (kb.personal?.location) lines.push(`Location: ${kb.personal.location}`);
  if (kb.personal?.summary) lines.push(`Summary: ${kb.personal.summary}`);

  const allSkills = [
    ...(kb.skills?.technical ?? []),
    ...(kb.skills?.tools ?? []),
    ...(kb.skills?.languages ?? []),
  ];
  if (allSkills.length) lines.push(`Skills: ${allSkills.join(', ')}`);

  if (kb.experience?.length) {
    lines.push(`Experience (${kb.experience.length} roles):`);
    kb.experience.forEach((e) =>
      lines.push(`  - ${e.role ?? '?'} at ${e.company ?? '?'} (${e.startDate ?? ''} – ${e.endDate ?? 'present'})`)
    );
  }
  if (kb.education?.length) {
    lines.push(`Education (${kb.education.length}):`);
    kb.education.forEach((e) =>
      lines.push(`  - ${e.degree ?? '?'} at ${e.institution ?? '?'}`)
    );
  }
  if (kb.projects?.length) {
    lines.push(`Projects (${kb.projects.length}):`);
    kb.projects.forEach((p) => lines.push(`  - ${p.name ?? '?'}: ${p.description ?? ''}`));
  }
  if (kb.certifications?.length)
    lines.push(`Certifications: ${kb.certifications.map((c) => c.name).join(', ')}`);
  if (kb.achievements?.length)
    lines.push(`Achievements: ${kb.achievements.map((a) => a.title).join(', ')}`);

  return lines.join('\n');
}

function formatHistoryForGemini(history: StoredChatMessage[]): string {
  return history
    .slice(-GEMINI_HISTORY_LIMIT)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

// ─── Intent router ────────────────────────────────────────────────────────────

const HELP_MESSAGE = `Here's everything I can do:

**Resume & Profile**
• Update your KB — "Add a project", "Update my skills", "Change my job title"
• Ask about your profile — "What are my top skills?", "How many projects do I have?"
• Upload a resume PDF — "Upload my resume"

**Job Search**
• Generate a tailored resume — paste a job description and I'll curate your best self
• ATS score — "Check my ATS score" (requires a generated resume)
• Cover letter — "Generate a cover letter" (requires a generated resume)
• Job fit — "How well do I fit this role?" (paste a JD)

**Interview Prep**
• Interview questions — "Prep me for interviews" or "Interview prep"
• Job-specific mock interview — "Prep me for my Google interview" (needs saved application + JD)
• Resume roast — "Roast my resume"

**Jobs & Applications (Phase 7)**
• Find jobs — "Find jobs for me", "Search ML engineer roles in US"
• Application pack — "Prepare application pack" (opens Jobs flow)
• Tracker — "Show my applications", "Move Stripe to interview stage"
• Skill gaps — "What skills am I missing?"

**Groups & Collaboration**
• Create a group — "Create a group named ..."
• Invite someone — "Add [userId] to my group"
• Bulk KB update — "Tell my group we all won Hackathon 2024 in AI"
• Peer comparison — "How do I compare to my group for SDE roles?"

**Public Profile**
• Share your profile — "Share my profile"

Type any of these to get started!`;

const INTENT_SYSTEM = `You are an intent router for a resume management chatbot. Given the user's message and their conversation history, identify the intent and extract relevant parameters. Return ONLY a JSON object with this structure: { "intent": string, "params": object, "reply": string }.
The reply field is what the chatbot says to the user before executing the intent. Keep replies short (1-2 sentences), friendly, and in first person ("I'll...", "Let me...").
Available intents:
- update_kb: user wants to update their profile/resume info. params must include { "section": string, "description": string } where section is one of personal/education/experience/projects/skills/certifications/achievements/publications.
- ask_kb: user asks something about their own profile. params: { "section": string or "all" }.
- generate_resume: user wants to create a tailored resume for a specific job. If the user pasted a job description, put the FULL text in params.jd. If they only asked without JD, omit jd. IMPORTANT: If the latest user message is mostly a pasted job posting (long text with responsibilities, requirements, qualifications, role title, or tech stack) — even with a short intro like "here is the JD" — use generate_resume and put the entire message in params.jd. Do NOT classify a pasted JD as chitchat.
- job_fit: user asks how well they fit a role (qualitative). params: { jd?: string } if JD is in the message.
- upload_resume: user wants to upload a new resume PDF.
- group_create: create a collaboration group. params: { name?: string } — if user gives the name in the message, include it.
- group_add_member: invite by Firebase userId. params: { targetUserId?: string }.
- group_update: bulk KB update for group members (admin). params: { description?: string, section?: string (default achievements), groupId?: string } — put the achievement/update text in description.
- peer_compare: anonymous skill comparison vs opted-in group peers. params: { groupId?: string, targetRole?: string } e.g. "SDE", "data science".
- share_profile: user wants their public profile URL.
- ats_check: check resume ATS compatibility score.
- cover_letter: generate a cover letter.
- roast_resume: give honest, blunt critique of resume.
- interview_prep: generate likely interview questions from resume (general).
- job_search: user wants a personalized job feed / listings. params: { query?: string, location?: string }.
- job_prepare: user wants tailored resume + cover letter + ATS for a specific role. params optional.
- tracker_query: view or update Kanban applications. params: { company?: string, targetStatus?: string } for moves.
- interview_train: job-specific timed or chat mock interview. params: { company?: string, role?: string, mode?: "chat_qa"|"timed_mock", focus?: "technical"|"behavioral"|"mixed" }.
- weak_spots: user wants skill gap report from last job search.
- chitchat: general conversation unrelated to resume. Never use chitchat for pasted job descriptions or for questions about whether resume generation finished or where the resume is.`;

async function routeIntent(
  message: string,
  history: StoredChatMessage[]
): Promise<IntentRouterResult> {
  if (!hasGeminiApiKeys()) {
    return {
      intent: 'router_failed',
      params: {},
      reply:
        'The server has no Gemini API keys configured. In Railway (or your API host), set GEMINI_API_KEYS (comma or newline separated) or GEMINI_API_KEY, redeploy the API, then try again.',
    };
  }

  const historyStr = formatHistoryForGemini(history);
  const prompt = `${INTENT_SYSTEM}\n\nConversation history:\n${historyStr || '(none)'}\n\nUser's latest message:\n${message}`;

  try {
    const raw = await geminiText(prompt);
    const parsed = JSON.parse(extractJSON(raw)) as IntentRouterResult;

    const validIntents: ChatIntent[] = [
      'update_kb', 'ask_kb', 'generate_resume', 'upload_resume',
      'group_create', 'group_add_member', 'group_update', 'peer_compare', 'share_profile',
      'ats_check', 'cover_letter', 'job_fit', 'roast_resume', 'interview_prep',
      'job_search', 'job_prepare', 'tracker_query', 'interview_train', 'weak_spots',
      'chitchat',
    ];

    if (!validIntents.includes(parsed.intent as ChatIntent)) {
      parsed.intent = 'chitchat';
    }

    return parsed;
  } catch (err) {
    console.error('[routeIntent]', err);
    const st = getGeminiFetchStatus(err);
    if (st === 429) {
      return {
        intent: 'router_failed',
        params: {},
        reply:
          'Gemini hit a rate or quota limit, so I cannot answer yet. Wait a few minutes, check usage in Google AI Studio, or enable billing. You can still use Import KB from JSON in Settings without the API.',
      };
    }
    if (st === 404) {
      return {
        intent: 'router_failed',
        params: {},
        reply:
          'The Gemini model in your server config is not available (404). Set GEMINI_MODEL in apps/api/.env to a model your API key supports.',
      };
    }
    if (err instanceof Error && err.message === 'TIMEOUT') {
      return {
        intent: 'router_failed',
        params: {},
        reply:
          'The AI router timed out (slow network or busy API). Retry in a moment; if it persists, check Railway logs and Gemini status.',
      };
    }
    if (err instanceof SyntaxError) {
      return {
        intent: 'router_failed',
        params: {},
        reply:
          'The AI returned an unexpected format for routing. Retry your message; if it keeps happening, check GEMINI_MODEL on the API server.',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const authHint =
      /API key|API_KEY|permission|401|403|invalid/i.test(msg) &&
      !/QUOTA|429|resource exhausted/i.test(msg);
    return {
      intent: 'router_failed',
      params: {},
      reply: authHint
        ? 'Gemini rejected the request (invalid API key or permission). Verify GEMINI_API_KEYS / GEMINI_API_KEY in Railway and that each key is valid in Google AI Studio.'
        : "I couldn't reach the AI (routing step). Check GEMINI_API_KEYS / GEMINI_API_KEY on your API server (not Vercel), redeploy after env changes, and inspect Railway logs for [routeIntent] errors.",
    };
  }
}

// ─── Intent handlers ──────────────────────────────────────────────────────────

async function handleUpdateKB(
  section: string,
  description: string,
  kb: KnowledgeBase
): Promise<KBPatchResult> {
  const validSections = ['personal', 'education', 'experience', 'projects', 'skills', 'certifications', 'achievements', 'publications'];
  const safeSection = validSections.includes(section) ? section : 'personal';
  const currentSection = (kb as unknown as Record<string, unknown>)[safeSection] ?? null;

  const prompt = `You are a resume knowledge base updater. You will be given a specific section of a user's knowledge base as JSON and a natural language description of what the user wants to change. Return ONLY a JSON object with two keys: "patch" (the full updated section JSON) and "summary" (a 1-2 sentence human-readable description of what changed). Do not add explanation or markdown.

Current KB section (${safeSection}):
${JSON.stringify(currentSection, null, 2)}

User wants to:
${description}`;

  const raw = await geminiText(prompt);
  const parsed = JSON.parse(extractJSON(raw)) as KBPatchResult;

  if (!parsed.patch || !parsed.summary) {
    throw new Error('Gemini returned incomplete patch');
  }

  return {
    patch: parsed.patch,
    summary: String(parsed.summary),
  };
}

async function handleAskKB(
  question: string,
  history: StoredChatMessage[],
  kb: KnowledgeBase
): Promise<string> {
  const historyStr = formatHistoryForGemini(history);
  const kbContext = serializeKBForContext(kb);

  const prompt = `You are a helpful resume assistant. Use the user's knowledge base below to answer their question conversationally and helpfully. Be specific and reference actual details from their profile.

User's Knowledge Base:
${kbContext}

Conversation history:
${historyStr || '(none)'}

User's question: ${question}`;

  return geminiText(prompt);
}

async function handleRoastResume(kb: KnowledgeBase): Promise<string> {
  const kbJson = JSON.stringify(kb, null, 2);

  const prompt = `You are a brutally honest but constructive career advisor giving a resume critique. Read the resume below and give a "roast" — be direct about weaknesses, vague language, missed opportunities, and improvements. Use a playful but genuinely helpful tone. Structure your response with a bold verdict line first, then specific issues as bullet points, then 3 actionable improvements. Keep it under 300 words.

Resume (JSON):
${kbJson}`;

  return geminiText(prompt);
}

async function handleInterviewPrep(userId: string, kb: KnowledgeBase): Promise<InterviewQuestion[]> {
  const kbContext = serializeKBForContext(kb);

  const prompt = `You are an interview coach. Based on the candidate's resume below, generate 8-10 likely interview questions they will face.

For each item use this JSON shape: { "type"?: string (e.g. Behavioral, Technical), "q": string, "hint": string, "answer": string }.
- "hint": one short personalized hint referencing their actual experience.
- "answer": first-person draft (2-4 sentences) they could say aloud; ground ONLY in the resume below; do not invent employers, dates, or metrics.

Return ONLY a JSON array, no markdown.

Resume summary:
${kbContext}`;

  const raw = await geminiText(prompt);
  const clean = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  const arrStart = clean.indexOf('[');
  const arrEnd = clean.lastIndexOf(']');
  const jsonStr = arrStart !== -1 && arrEnd !== -1 ? clean.slice(arrStart, arrEnd + 1) : clean;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const normalized = normalizeStoredQuestions(parsed).slice(0, 10);
  if (normalized.length) {
    await saveInterviewPrep(userId, 'general', normalized, null);
  }
  return normalized
    .map((s) => ({
      q: (s.q || s.question || '').trim(),
      hint: s.hint,
      answer: s.answer || undefined,
      type: s.type,
    }))
    .filter((q) => q.q.length > 0);
}

async function handleChitchat(
  message: string,
  history: StoredChatMessage[]
): Promise<string> {
  const historyStr = formatHistoryForGemini(history);

  const prompt = `You are ResumeForge, a friendly AI assistant for resume building and career advice. Answer the user's message naturally. Keep responses concise (2-4 sentences).

Rules:
- You cannot see the app's Resume Preview panel or whether a resume PDF was actually built. Never say a tailored resume "is ready", "has been generated", or "check the preview" unless you are only giving general how-to advice.
- If they ask whether generation ran or why the preview is empty, say you are not connected to that state and suggest they open the Resume Preview tab, refresh, or paste the full job description again (100+ characters) to trigger generation.

Conversation history:
${historyStr || '(none)'}

User: ${message}`;

  return geminiText(prompt);
}

/** User asking if generation ran / why preview is empty — answer from real session, not LLM fiction. */
function isResumeGenerationStatusQuery(message: string): boolean {
  const m = message.toLowerCase();
  const topic =
    m.includes('generat') ||
    m.includes('resume') ||
    m.includes('preview') ||
    m.includes('tailored') ||
    m.includes('ats');
  const doubtOrWhere =
    m.includes("n't") ||
    m.includes('not ') ||
    m.includes('still ') ||
    m.includes('where ') ||
    m.includes('when ') ||
    m.includes('why ') ||
    m.includes('haven') ||
    m.includes('empty') ||
    m.includes('nothing') ||
    m.includes('placeholder') ||
    m.includes('without') ||
    m.includes('start') ||
    m.includes('started') ||
    m.includes('finish') ||
    m.includes('ready') ||
    m.includes('missing') ||
    m.includes('working');
  return topic && doubtOrWhere;
}

function sessionHasUsableResume(session: Awaited<ReturnType<typeof getSession>>): boolean {
  const r = session?.latestResume;
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return Boolean(
    o.targetRole ||
      o.summary ||
      (Array.isArray(o.experience) && o.experience.length > 0) ||
      (Array.isArray(o.projects) && o.projects.length > 0)
  );
}

async function resumeGenerationStatusResponse(userId: string): Promise<ChatResponse> {
  const session = await getSession(userId);
  if (sessionHasUsableResume(session)) {
    const score = session!.lastAts?.score;
    return {
      intent: 'chitchat',
      reply: `Your session **does** have a last generated resume (ATS was ${score != null ? `${score}/100` : 'scored earlier'}). Open the **Resume Preview** tab — the UI should load it from here. If you still see the placeholder, try clicking **Resume Preview** again or refresh the page. If you never saw a message starting with "Done — I've built…", say **Regenerate** and paste the full JD in one message (100+ characters).`,
      data: {
        refinedResume: session!.latestResume,
        atsScore: session!.lastAts,
        jd: session!.jd,
        suggestions: ['Check my ATS score', 'Generate a cover letter', 'Regenerate with a new JD'],
      },
    };
  }
  return {
    intent: 'chitchat',
    reply: `There is **no** tailored resume saved in your session yet — so the preview panel will stay empty until generation succeeds. Paste the **full job description** in one message (about 100+ characters from the posting). I'll reply with "Done — I've built…" when it actually finishes. Short lines like only "generate my resume" are not enough on their own.`,
    data: {
      awaitingJobDescription: true,
      suggestions: ['Here is the job description:', 'Generate resume for a software engineer role'],
    },
  };
}

// ─── Suggestion chips per intent ──────────────────────────────────────────────

const SUGGESTIONS_MAP: Partial<Record<ChatIntent, string[]>> = {
  update_kb: ['Add another detail', 'Generate resume with these changes', 'What does my profile look like now?'],
  ask_kb: ['Show my full skills', 'How many projects do I have?', 'Generate a resume'],
  roast_resume: ['Fix the weak points', 'Generate a better version', 'Interview prep'],
  interview_prep: ['Help me answer these', 'Generate a resume', 'Add more experience'],
  upload_resume: ['What changed?', 'Show my knowledge base', 'Generate a tailored resume'],
  generate_resume: ['Generate a cover letter', 'How well do I fit this role?', 'Check my ATS score'],
  ats_check: ['Improve my keywords', 'Generate cover letter', 'Regenerate resume'],
  cover_letter: ['Download cover letter PDF', 'Regenerate resume', 'Interview prep'],
  job_fit: ['Add missing skills to my profile', 'Generate a tailored resume', 'Interview prep'],
  group_create: ['Add a member with their user ID', 'Tell my group we won a hackathon'],
  share_profile: ['Generate a tailored resume', 'Compare me to my group'],
  job_search: ['Show my applications', 'What skills am I missing?', 'Prep me for interviews'],
  job_prepare: ['Find jobs for me', 'Show my applications'],
  tracker_query: ['Find jobs for me', 'What skills am I missing?'],
  interview_train: ['Show my applications', 'Find jobs for me'],
  weak_spots: ['Find jobs for me', 'Update my skills'],
};

// ─── Main entry point ─────────────────────────────────────────────────────────

async function buildGroupBulkMemberPicker(
  userId: string,
  groupId: string,
  description: string,
  section: string
): Promise<ChatResponse> {
  const adminG = await listAdminGroups(userId);
  const g = adminG.find((x) => x.groupId === groupId);
  if (!g) {
    return {
      intent: 'group_update',
      reply: 'That group was not found or you are not an admin.',
      data: {},
    };
  }
  const labels = await Promise.all(
    g.members.map(async (m) => {
      const d = await db.collection('users').doc(m.userId).get();
      return {
        userId: m.userId,
        label: (d.data()?.displayName as string) || m.userId.slice(0, 8),
      };
    })
  );
  return {
    intent: 'group_update',
    reply:
      'Select members below, then Preview updates to see per-person diffs. Confirm all applies everyone\'s patch.',
    data: {
      groupBulk: {
        phase: 'pick_members',
        groupId: g.groupId,
        groupName: g.name,
        description,
        section,
        members: labels,
      },
      suggestions: ['Compare me to my group for SDE roles'],
    },
  };
}

async function peerCompareResolved(
  userId: string,
  groupId: string,
  targetRole: string
): Promise<ChatResponse> {
  try {
    const comp = await withLongTimeout(
      peerCompareInGroup(userId, groupId, targetRole.trim() || 'Software engineering roles')
    );
    return {
      intent: 'peer_compare',
      reply:
        'Here is an anonymous comparison against opted-in group peers (no names exposed).',
      data: { peerComparison: comp, suggestions: ['Add a skill to close a gap'] },
    };
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    if (code === 'NO_PEERS') {
      return {
        intent: 'peer_compare',
        reply:
          'No peers in this group opted into anonymous comparison yet. Ask them to enable it in Profile.',
        data: {},
      };
    }
    if (code === 'NO_KB') {
      return {
        intent: 'peer_compare',
        reply: 'Upload or build your KB first so I can compare you.',
        data: { suggestions: ['Upload my resume'] },
      };
    }
    if (code === 'NOT_MEMBER') {
      return {
        intent: 'peer_compare',
        reply: 'You are not a member of that group.',
        data: {},
      };
    }
    throw e;
  }
}

export async function processMessage(
  userId: string,
  message: string,
  history: StoredChatMessage[],
  continuation?: ChatContinuation
): Promise<ChatResponse> {
  // ? / help shortcut — no Gemini call needed
  const trimmed = message.trim().toLowerCase();
  if (trimmed === '?' || trimmed === 'help' || trimmed === '/help') {
    return {
      intent: 'chitchat',
      reply: HELP_MESSAGE,
      data: {},
    };
  }

  if (continuation?.type === 'group_update_pick') {
    const { groupId, description, section } = continuation;
    if (!description?.trim() || !section?.trim()) {
      return {
        intent: 'group_update',
        reply: 'Missing update details. Ask for a bulk group update again.',
        data: {},
      };
    }
    return buildGroupBulkMemberPicker(
      userId,
      groupId,
      description.trim(),
      section.trim()
    );
  }
  if (continuation?.type === 'peer_compare_pick') {
    return peerCompareResolved(
      userId,
      continuation.groupId,
      continuation.targetRole || 'Software engineering roles'
    );
  }

  let intentResult: IntentRouterResult;

  try {
    intentResult = await withTimeout(routeIntent(message, history));
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'TIMEOUT';
    return {
      intent: 'chitchat',
      reply: isTimeout ? TIMEOUT_REPLY : "Something went wrong. Please try again.",
    };
  }

  const { intent, params, reply } = intentResult;

  if (intent === 'chitchat' && isResumeGenerationStatusQuery(message)) {
    return resumeGenerationStatusResponse(userId);
  }

  const data: ChatResponseData = {
    suggestions: SUGGESTIONS_MAP[intent as ChatIntent],
  };

  try {
    switch (intent as ChatIntent) {
      case 'router_failed':
        return {
          intent: 'chitchat',
          reply,
          data: {},
        };

      case 'update_kb': {
        const section = params.section || 'personal';
        const description = params.description || message;
        const kb = await getKB(userId);

        if (!kb) {
          return {
            intent: 'update_kb',
            reply: "You don't have a knowledge base yet. Upload your resume first!",
            data: { suggestions: ['Upload my resume'] },
          };
        }

        const patchResult = await withTimeout(
          handleUpdateKB(section, description, kb)
        );

        const currentSection = (kb as unknown as Record<string, unknown>)[section] ?? null;

        return {
          intent: 'update_kb',
          reply,
          data: {
            section,
            patch: patchResult.patch,
            patchSummary: patchResult.summary,
            currentSection,
            suggestions: SUGGESTIONS_MAP.update_kb,
          },
        };
      }

      case 'ask_kb': {
        const kb = await getKB(userId);
        if (!kb) {
          return {
            intent: 'ask_kb',
            reply: "You don't have a knowledge base yet. Upload your resume to get started!",
            data: { suggestions: ['Upload my resume'] },
          };
        }
        const answer = await withTimeout(handleAskKB(message, history, kb));
        return { intent: 'ask_kb', reply: answer, data };
      }

      case 'roast_resume': {
        const kb = await getKB(userId);
        if (!kb) {
          return { intent: 'roast_resume', reply: "Nothing to roast yet — upload your resume first!", data };
        }
        const roast = await withTimeout(handleRoastResume(kb));
        return {
          intent: 'roast_resume',
          reply: roast,
          data: { isRoast: true, suggestions: SUGGESTIONS_MAP.roast_resume },
        };
      }

      case 'interview_prep': {
        const kb = await getKB(userId);
        if (!kb) {
          return { intent: 'interview_prep', reply: "Upload your resume first so I can tailor the questions to you!", data };
        }
        const questions = await withTimeout(handleInterviewPrep(userId, kb));
        return {
          intent: 'interview_prep',
          reply,
          data: { questions, suggestions: SUGGESTIONS_MAP.interview_prep },
        };
      }

      case 'upload_resume':
        return {
          intent: 'upload_resume',
          reply,
          data: { showUpload: true, suggestions: SUGGESTIONS_MAP.upload_resume },
        };

      case 'generate_resume': {
        const jdRaw = (params.jd || '').trim();
        const jd =
          jdRaw ||
          (message.trim().length > 200 ? message.trim() : '');
        if (jd.length < 100) {
          return {
            intent: 'generate_resume',
            reply:
              "I haven’t started yet — I need the **full job description** (about 100+ characters) in your next message. Paste the JD text from the posting, then I’ll build your tailored resume and ATS score in the Resume Preview panel.",
            data: {
              awaitingJobDescription: true,
              suggestions: [
                'Here is the job description:',
                'Generate resume for a software engineer role',
              ],
            },
          };
        }
        const kbGen = await getKB(userId);
        if (!kbGen) {
          return {
            intent: 'generate_resume',
            reply: "You need a knowledge base first — upload your resume, then try again.",
            data: { suggestions: ['Upload my resume'] },
          };
        }
        const refined = await withLongTimeout(generateRefinedResume(kbGen, jd));
        const ats = await withLongTimeout(scoreATS(jd, refined));
        await saveSession(userId, { jd, latestResume: refined, lastAts: ats });
        return {
          intent: 'generate_resume',
          reply: `Done — I've built a long-form tailored resume (full depth from your profile, aligned to the JD). Open the Resume Preview panel to switch templates (Minimal / Modern / Academic), see your ATS score (${ats.score}/100), and download PDF or JSON. Expand "Why these items?" below for transparency.`,
          data: {
            refinedResume: refined,
            reasoning: refined.reasoning,
            atsScore: ats,
            jd,
            suggestions: SUGGESTIONS_MAP.generate_resume,
          },
        };
      }

      case 'ats_check': {
        const sessionAts = await getSession(userId);
        if (!sessionAts?.latestResume || !sessionAts.jd) {
          return {
            intent: 'ats_check',
            reply:
              'Generate a tailored resume first (paste a job description in chat). Then I can score ATS alignment.',
            data: { suggestions: ['Generate resume for a job'] },
          };
        }
        const ats = await withLongTimeout(scoreATS(sessionAts.jd, sessionAts.latestResume));
        await saveSession(userId, { lastAts: ats });
        return {
          intent: 'ats_check',
          reply: `ATS score: ${ats.score}/100. See the Resume panel for matched vs missing keywords and suggestions.`,
          data: {
            atsScore: ats,
            refinedResume: sessionAts.latestResume,
            jd: sessionAts.jd,
            suggestions: SUGGESTIONS_MAP.ats_check,
          },
        };
      }

      case 'cover_letter': {
        const sessionCl = await getSession(userId);
        if (!sessionCl?.latestResume || !sessionCl.jd) {
          return {
            intent: 'cover_letter',
            reply:
              'Generate a tailored resume with a job description first — then I can write your cover letter.',
            data: { suggestions: ['Generate resume for a job'] },
          };
        }
        const letter = await withLongTimeout(
          generateCoverLetter(sessionCl.jd, sessionCl.latestResume)
        );
        await saveSession(userId, { lastCoverLetter: letter });

        // Make the generated resume + cover letter appear in "My Applications".
        // This turns the chat-generated JD/resume artifacts into an application tracker row
        // so users can continue with interview Q&A and status tracking.
        createOrUpdateApplicationFromResumeSession(userId).catch((e) =>
          console.error('[AUTO SAVE applications from cover_letter]', e)
        );

        return {
          intent: 'cover_letter',
          reply:
            "Your cover letter is ready — check the Resume panel to read, copy, or download as PDF.",
          data: {
            coverLetterText: letter,
            refinedResume: sessionCl.latestResume,
            atsScore: sessionCl.lastAts,
            jd: sessionCl.jd,
            suggestions: SUGGESTIONS_MAP.cover_letter,
          },
        };
      }

      case 'job_fit': {
        let jdFit = (params.jd || '').trim();
        if (!jdFit) {
          const s = await getSession(userId);
          jdFit = (s?.jd || '').trim();
        }
        if (!jdFit && message.trim().length > 200) jdFit = message.trim();
        if (jdFit.length < 80) {
          return {
            intent: 'job_fit',
            reply:
              'Paste the job description (or generate a tailored resume first) so I can assess your fit.',
            data: { suggestions: ['How well do I fit if I paste the JD here?'] },
          };
        }
        const kbFit = await getKB(userId);
        if (!kbFit) {
          return {
            intent: 'job_fit',
            reply: 'Upload your resume so I have your full profile to compare against the role.',
            data: { suggestions: ['Upload my resume'] },
          };
        }
        const fit = await withLongTimeout(assessJobFit(jdFit, kbFit));
        return {
          intent: 'job_fit',
          reply: `Here's my honest read on your fit for this role (${fit.overallFit}/100).`,
          data: {
            jobFit: fit,
            jd: jdFit,
            suggestions: SUGGESTIONS_MAP.job_fit,
          },
        };
      }

      case 'group_create': {
        let name = (params.name || '').trim();
        if (name.length < 2) {
          const m = message.match(/name\s+(?:it\s+)?["']?([^"'\n]+)["']?/i);
          if (m) name = m[1].trim();
        }
        if (name.length < 2) {
          return {
            intent: 'group_create',
            reply:
              reply ||
              'What should we call the group? (e.g. "Name it Hack Squad")',
            data: { suggestions: ['Name it Study Crew'] },
          };
        }
        const g = await createGroup(userId, name);
        return {
          intent: 'group_create',
          reply: `Created "${g.name}". Share this group ID so others can ask to join: ${g.groupId}`,
          data: {
            groupId: g.groupId,
            groupName: g.name,
            suggestions: SUGGESTIONS_MAP.group_create,
          },
        };
      }

      case 'group_add_member': {
        let target = (params.targetUserId || '').trim();
        if (!target) {
          const uidMatch = message.match(
            /(?:add|invite)\s+([a-zA-Z0-9]{20,})\b/i
          );
          if (uidMatch) target = uidMatch[1];
        }

        // Support "join <groupId>" / "request group <groupId>"
        // Users can share a group ID and expect to join with it (not by providing their User ID as "targetUserId").
        if (!target) {
          const joinMatch = message.match(
            /(?:join|request)\s+(?:group\s*)?([a-zA-Z0-9]{20,})\b/i
          );
          if (joinMatch) {
            const groupId = joinMatch[1];
            const out = await joinGroupById(userId, groupId);
            if (!out.ok) {
              return {
                intent: 'group_add_member',
                reply: 'That group was not found. Double-check the Group ID and try again.',
                data: {},
              };
            }
            return {
              intent: 'group_add_member',
              reply: `Joined "${out.groupName}". Open the Group tab to see members.`,
              data: { groupId, suggestions: ['Tell my group what you worked on'] },
            };
          }
        }

        if (!target) {
          return {
            intent: 'group_add_member',
            reply:
              'Paste the member\'s User ID (Profile → copy ID). Example: add vqR3kLm9... to my group',
            data: {},
          };
        }
        const groups = await listGroupsForUser(userId);
        if (!groups.length) {
          return {
            intent: 'group_add_member',
            reply: 'Create a group first, then invite members.',
            data: { suggestions: ['Create a group named …'] },
          };
        }
        if (groups.length === 1) {
          const r = await sendGroupInvite(userId, groups[0].groupId, target);
          if (!r.ok) {
            return {
              intent: 'group_add_member',
              reply: r.error,
              data: {},
            };
          }
          return {
            intent: 'group_add_member',
            reply: `Invite sent. They'll see a notification when they open ResumeForge.`,
            data: { groupId: groups[0].groupId },
          };
        }
        return {
          intent: 'group_add_member',
          reply: `Choose a group to invite ${target.slice(0, 8)}… to:`,
          data: {
            invitePick: {
              targetUserId: target,
              groups: groups.map((gr) => ({ groupId: gr.groupId, name: gr.name })),
            },
          },
        };
      }

      case 'group_update': {
        const description = (params.description || message).trim();
        const section = (params.section || 'achievements').trim();
        if (description.length < 10) {
          return {
            intent: 'group_update',
            reply: 'Tell me what to add (e.g. "we all won Smart India Hackathon 2024 in the AI track").',
            data: {},
          };
        }
        const adminG = await listAdminGroups(userId);
        if (!adminG.length) {
          return {
            intent: 'group_update',
            reply: "Only group admins can push updates to members' knowledge bases.",
            data: {},
          };
        }
        let gid = (params.groupId || '').trim();
        if (!gid && adminG.length === 1) gid = adminG[0].groupId;
        if (!gid) {
          return {
            intent: 'group_update',
            reply: 'Pick a group for this bulk update:',
            data: {
              adminGroupChoices: adminG.map((gr) => ({
                groupId: gr.groupId,
                name: gr.name,
              })),
              bulkDescription: description,
              bulkSection: section,
            },
          };
        }
        const g = adminG.find((x) => x.groupId === gid);
        if (!g) {
          return { intent: 'group_update', reply: 'That group was not found or you are not an admin.', data: {} };
        }
        return buildGroupBulkMemberPicker(userId, gid, description, section);
      }

      case 'peer_compare': {
        const targetRole = (params.targetRole || 'Software engineering roles').trim();
        const groups = await listGroupsForUser(userId);
        if (!groups.length) {
          return {
            intent: 'peer_compare',
            reply: 'Join a group first — then I can compare you to peers who opted in.',
            data: {},
          };
        }
        let gid = (params.groupId || '').trim();
        if (!gid && groups.length === 1) gid = groups[0].groupId;
        if (!gid) {
          return {
            intent: 'peer_compare',
            reply: 'Which group should I use for the comparison?',
            data: {
              peerComparePickGroup: {
                targetRole,
                groups: groups.map((gr) => ({ groupId: gr.groupId, name: gr.name })),
              },
            },
          };
        }
        return peerCompareResolved(userId, gid, targetRole);
      }

      case 'share_profile': {
        const udoc = await db.collection('users').doc(userId).get();
        const username = udoc.data()?.username as string | undefined;
        if (!username) {
          return {
            intent: 'share_profile',
            reply: 'Set a username under Profile → settings, then ask again.',
            data: {},
          };
        }
        const base = (
          process.env.APP_PUBLIC_URL ||
          process.env.FRONTEND_URL ||
          'http://localhost:3000'
        ).replace(/\/$/, '');
        const url = `${base}/u/${username}`;
        return {
          intent: 'share_profile',
          reply: `Your public profile:\n${url}`,
          data: {
            publicProfileUrl: url,
            suggestions: SUGGESTIONS_MAP.share_profile,
          },
        };
      }

      case 'job_search': {
        try {
          const out = await withLongTimeout(handleJobSearchIntent(userId, params));
          return { intent: 'job_search', reply: out.reply, data: out.data };
        } catch (e) {
          console.error('[job_search]', e);
          return {
            intent: 'job_search',
            reply: "I couldn't complete job search. Ensure your KB exists and API keys are set for job providers.",
            data: { suggestions: SUGGESTIONS_MAP.job_search },
          };
        }
      }

      case 'job_prepare': {
        const out = handleJobPrepareIntent();
        return { intent: 'job_prepare', reply: out.reply, data: out.data };
      }

      case 'tracker_query': {
        try {
          const out = await withTimeout(handleTrackerQueryIntent(userId, message));
          return { intent: 'tracker_query', reply: out.reply, data: out.data };
        } catch (e) {
          console.error('[tracker_query]', e);
          return {
            intent: 'tracker_query',
            reply: 'Could not load your applications.',
            data: {},
          };
        }
      }

      case 'interview_train': {
        try {
          const out = await withLongTimeout(handleInterviewTrainIntent(userId, message, params));
          return { intent: 'interview_train', reply: out.reply, data: out.data };
        } catch (e) {
          console.error('[interview_train]', e);
          return {
            intent: 'interview_train',
            reply: "Couldn't start interview training. Check Gemini quota or save a job with a JD first.",
            data: { suggestions: SUGGESTIONS_MAP.interview_train },
          };
        }
      }

      case 'weak_spots': {
        try {
          const out = await withTimeout(handleWeakSpotsIntent(userId));
          return { intent: 'weak_spots', reply: out.reply, data: out.data };
        } catch (e) {
          console.error('[weak_spots]', e);
          return {
            intent: 'weak_spots',
            reply: 'Could not load skill gaps.',
            data: {},
          };
        }
      }

      case 'chitchat':
      default: {
        const chitchatReply = await withTimeout(handleChitchat(message, history));
        return { intent: 'chitchat', reply: chitchatReply, data: { suggestions: undefined } };
      }
    }
  } catch (err) {
    console.error('[processMessage]', intent, err);
    const isTimeout = err instanceof Error && err.message === 'TIMEOUT';
    if (intent === 'generate_resume') {
      return {
        intent: 'generate_resume',
        reply: isTimeout
          ? 'Resume generation timed out — try again with the same JD, or a slightly shorter posting.'
          : "I couldn't finish building your resume (the model response may have been invalid). Paste the **full job description** again in one message, or try regenerating.",
        data: {
          awaitingJobDescription: true,
          suggestions: ['Here is the job description:', 'Generate resume for a software engineer role'],
        },
      };
    }
    return {
      intent: intent as ChatIntent,
      reply: isTimeout ? TIMEOUT_REPLY : reply,
      data: {},
    };
  }
}
