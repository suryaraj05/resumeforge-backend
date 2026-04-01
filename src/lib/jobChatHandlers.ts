import { searchJobsForUser } from './jobSearchService';
import {
  listApplicationsGrouped,
  findApplicationByCompany,
  updateApplication,
} from './applicationsService';
import { getStoredWeakSpotReport } from './weakSpotsService';
import { startInterviewSession } from './interviewCareerService';
import type { ChatResponse, ChatResponseData } from '../types/chat';

export async function handleJobSearchIntent(
  userId: string,
  params: Record<string, string>
): Promise<{ reply: string; data: ChatResponseData }> {
  const query = (params.query || '').trim() || undefined;
  const location = (params.location || '').trim() || undefined;
  const result = await searchJobsForUser(userId, { query, location, page: 1 });
  const top = result.jobs.slice(0, 5);
  const jobCards = top.map((j) => ({
    jobId: j.jobId,
    title: j.title,
    company: j.company,
    fitScore: j.score.fitScore,
    location: j.location,
    whyThisRole: j.score.whyThisRole,
  }));
  const reply =
    top.length === 0
      ? "I didn't find listings for that search. Try widening location or query, or open the Jobs page to filter further."
      : `Here are ${top.length} roles ranked by fit. Open **Jobs** for the full feed, filters, and application pack.`;
  return {
    reply,
    data: {
      jobCards,
      suggestions: ['Show my applications', 'What skills am I missing?', 'Open Jobs page'],
    },
  };
}

export async function handleWeakSpotsIntent(userId: string): Promise<{ reply: string; data: ChatResponseData }> {
  const report = await getStoredWeakSpotReport(userId);
  if (!report?.topGaps?.length) {
    return {
      reply:
        'Run a job search first (say **find jobs for me** or open the Jobs page) so I can analyze gaps from real listings.',
      data: { suggestions: ['Find jobs for me', 'Search ML engineer roles in US'] },
    };
  }
  const lines = report.topGaps.map((g) => `• **${g.skill}** — ${g.estimatedImpact} (${g.learningTimeEstimate})`);
  return {
    reply: `${report.summary}\n\nTop gaps:\n${lines.join('\n')}`,
    data: {
      weakSpotReport: report,
      suggestions: ['Find jobs for me', 'Update my skills in chat'],
    },
  };
}

function parseTrackerCommand(message: string): {
  move?: { company: string; status: 'saved' | 'applied' | 'interview' | 'offer' | 'rejected' };
} {
  const m = message.toLowerCase();
  const moveMatch = m.match(
    /move\s+(.+?)\s+to\s+(saved|applied|interview|offer|rejected)\b/
  );
  if (moveMatch) {
    return {
      move: {
        company: moveMatch[1].replace(/["']/g, '').trim(),
        status: moveMatch[2] as 'saved' | 'applied' | 'interview' | 'offer' | 'rejected',
      },
    };
  }
  return {};
}

export async function handleTrackerQueryIntent(
  userId: string,
  message: string
): Promise<{ reply: string; data: ChatResponseData }> {
  const cmd = parseTrackerCommand(message);
  if (cmd.move) {
    const app = await findApplicationByCompany(userId, cmd.move.company);
    if (!app) {
      return {
        reply: `I couldn't find an application matching "${cmd.move.company}". Save the job from the Jobs page first.`,
        data: { suggestions: ['Show my applications'] },
      };
    }
    await updateApplication(userId, app.applicationId, { status: cmd.move.status });
    return {
      reply: `Updated **${app.company}** — **${app.jobTitle}** to **${cmd.move.status}**.`,
      data: { suggestions: ['Show my applications', 'Prep me for interviews'] },
    };
  }

  const { byStatus, all } = await listApplicationsGrouped(userId);
  const total = all.length;
  const applied = byStatus.applied.length;
  const interviews = byStatus.interview.length;
  const offers = byStatus.offer.length;
  const rate = applied > 0 ? Math.round((interviews / applied) * 100) : 0;

  const recent = all.slice(0, 6).map((a) => `• ${a.company} — ${a.jobTitle} (${a.status})`);
  const reply = `**Tracker:** ${total} total · ${applied} applied · ${interviews} in interview · ${offers} offers · interview rate ${rate}% (interviews/applied).\n\nRecent:\n${recent.join('\n') || '(none yet)'}`;

  return {
    reply,
    data: {
      applicationStats: { total, applied, interviews, offers, interviewRate: rate },
      suggestions: ['Find jobs for me', 'Move Google to interview stage'],
    },
  };
}

export async function handleInterviewTrainIntent(
  userId: string,
  message: string,
  params: Record<string, string>
): Promise<{ reply: string; data: ChatResponseData }> {
  let company = (params.company || '').trim();
  if (!company) {
    const quoted = message.match(/(?:for|at)\s+([A-Za-z0-9][A-Za-z0-9\s.&-]{1,40})/i);
    if (quoted) company = quoted[1].trim();
  }

  const app = company ? await findApplicationByCompany(userId, company) : null;
  const jd = app?.jdText ?? '';
  const role = app?.jobTitle ?? (params.role || 'Software Engineer').trim();
  const comp = app?.company ?? (company || 'Target company');

  if (!jd || jd.length < 40) {
    return {
      reply:
        'Save a job to your tracker from the **Jobs** page first (so I have the JD), or paste a job description and tell me the company name.',
      data: {
        suggestions: ['Show my applications', 'Find jobs for me'],
      },
    };
  }

  const mode = params.mode === 'timed_mock' ? 'timed_mock' : 'chat_qa';
  const focus =
    params.focus === 'technical' || params.focus === 'behavioral' ? params.focus : 'mixed';

  const session = await startInterviewSession({
    userId,
    applicationId: app?.applicationId ?? null,
    company: comp,
    role,
    jdText: jd,
    mode: mode as 'chat_qa' | 'timed_mock',
    focus: focus as 'technical' | 'behavioral' | 'mixed',
  });

  const first = session.questions[0];
  const base =
    (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const url = `${base}/jobs/interview/${session.sessionId}`;

  return {
    reply: `Started **${mode === 'timed_mock' ? 'Timed mock' : 'Chat Q&A'}** prep for **${comp}** (${focus}). First question: **${first?.question ?? 'Open the session link'}**\n\nFull experience (timers, scorecard): ${url}`,
    data: {
      interviewSessionId: session.sessionId,
      interviewSessionUrl: url,
      suggestions: ['Open interview session', 'Show my applications'],
    },
  };
}

export function handleJobPrepareIntent(): { reply: string; data: ChatResponseData } {
  const base =
    (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return {
    reply: `Open the **Jobs** page, pick a role, and click **Prepare for this job** — I'll run resume, ATS, and cover letter together. ${base}/jobs`,
    data: {
      suggestions: ['Find jobs for me', 'Show my applications'],
    },
  };
}
