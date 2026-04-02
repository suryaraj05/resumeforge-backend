import { db } from './firebase';
import { getGeminiModelId } from './geminiModels';
import { hasGeminiApiKeys, nextGoogleGenerativeAI } from './geminiKeys';
import type { JobScoreResult, WeakSpotReport } from '../types/jobs';

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

function weakSpotRef(userId: string) {
  return db.collection('users').doc(userId).collection('jobWeakSpots').doc('latest');
}

export async function getStoredWeakSpotReport(userId: string): Promise<WeakSpotReport | null> {
  const snap = await weakSpotRef(userId).get();
  if (!snap.exists) return null;
  return snap.data() as WeakSpotReport;
}

function aggregateMissing(scores: JobScoreResult[]): string[] {
  const counts = new Map<string, number>();
  for (const s of scores) {
    for (const m of s.missingSkills ?? []) {
      const k = m.trim().toLowerCase();
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([skill]) => skill);
}

export async function buildWeakSpotReportFromScores(
  userId: string,
  scores: JobScoreResult[],
  jobCount: number
): Promise<WeakSpotReport | null> {
  if (jobCount < 10) return null;

  const missingList = aggregateMissing(scores);
  if (!missingList.length) return null;

  const report: WeakSpotReport = {
    topGaps: missingList.slice(0, 5).map((skill) => ({
      skill,
      appearsInJobs: scores.filter((s) =>
        (s.missingSkills ?? []).some((x) => x.toLowerCase() === skill)
      ).length,
      estimatedImpact: '—',
      learningTimeEstimate: '—',
    })),
    summary: 'Add these skills to your KB to improve match rates.',
    generatedAt: new Date().toISOString(),
    fromJobCount: jobCount,
  };

  if (!hasGeminiApiKeys()) {
    await weakSpotRef(userId).set(report);
    return report;
  }

  try {
    const model = nextGoogleGenerativeAI().getGenerativeModel({
      model: getGeminiModelId(),
      generationConfig: { responseMimeType: 'application/json' },
    });

    const system = `You are a career strategist. Given a list of missing skills extracted from multiple job listings the user did NOT fully match, identify the top 3 highest-impact skills to learn. Return ONLY JSON: { topGaps: [{ skill: string, appearsInJobs: number, estimatedImpact: string, learningTimeEstimate: string }], summary: string (1 sentence actionable advice) }. Do not add explanation or markdown.`;

    const user = `Missing skills across ${jobCount} job listings:\n${JSON.stringify(missingList.slice(0, 40))}`;

    const result = await model.generateContent(`${system}\n\n${user}`);
    const raw = result.response.text().trim();
    const parsed = JSON.parse(extractJSON(raw)) as Partial<WeakSpotReport>;

    const enriched: WeakSpotReport = {
      topGaps: Array.isArray(parsed.topGaps)
        ? parsed.topGaps.slice(0, 3).map((g) => ({
            skill: String((g as { skill?: string }).skill ?? ''),
            appearsInJobs: Number((g as { appearsInJobs?: number }).appearsInJobs) || 0,
            estimatedImpact: String((g as { estimatedImpact?: string }).estimatedImpact ?? '—'),
            learningTimeEstimate: String((g as { learningTimeEstimate?: string }).learningTimeEstimate ?? '—'),
          }))
        : report.topGaps.slice(0, 3),
      summary: String(parsed.summary ?? report.summary),
      generatedAt: new Date().toISOString(),
      fromJobCount: jobCount,
    };

    await weakSpotRef(userId).set(enriched);
    return enriched;
  } catch (e) {
    console.warn('[weakSpots] Gemini failed', e);
    await weakSpotRef(userId).set(report);
    return report;
  }
}
