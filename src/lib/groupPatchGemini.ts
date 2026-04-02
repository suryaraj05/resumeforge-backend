import { getGeminiModelId } from './geminiModels';
import { nextGoogleGenerativeAI } from './geminiKeys';
import { KnowledgeBase } from '../types/kb';

const TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    ),
  ]);
}

function extractJSON(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) return raw.slice(start, end + 1);
  return raw;
}

export interface GroupPatchGeminiResult {
  section: string;
  patch: unknown;
  summary: string;
}

const SYSTEM = `You are updating a specific user's resume knowledge base. Given their current KB section and a description of an achievement or update to add, return a JSON patch for that section. Return ONLY JSON: { "section": string, "patch": object, "summary": string }. The patch must be the full updated section value (same shape as the input section). Do not add explanation or markdown.`;

export async function generateGroupMemberPatch(
  section: string,
  currentSectionJson: unknown,
  updateDescription: string
): Promise<GroupPatchGeminiResult> {
  const model = nextGoogleGenerativeAI().getGenerativeModel({ model: getGeminiModelId() });
  const prompt = `${SYSTEM}

User's current ${section} KB:
${JSON.stringify(currentSectionJson, null, 2)}

Update to apply:
${updateDescription}`;

  const result = await withTimeout(model.generateContent(prompt), TIMEOUT_MS);
  const raw = result.response.text().trim();
  const parsed = JSON.parse(extractJSON(raw)) as GroupPatchGeminiResult;

  if (!parsed.section || parsed.patch === undefined || !parsed.summary) {
    throw new Error('Invalid Gemini group patch response');
  }

  return {
    section: String(parsed.section),
    patch: parsed.patch,
    summary: String(parsed.summary),
  };
}

export function anonymizeKBForPeer(kb: KnowledgeBase, index: number): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(kb)) as KnowledgeBase;
  if (clone.personal) {
    delete clone.personal.name;
    delete clone.personal.email;
    delete clone.personal.phone;
    delete clone.personal.linkedin;
    delete clone.personal.github;
    delete clone.personal.portfolio;
  }
  return {
    peerIndex: index,
    knowledgeBase: clone,
  };
}

export async function runPeerComparison(
  userKb: KnowledgeBase,
  peerAnonKbs: Record<string, unknown>[],
  targetRole: string
): Promise<{
  userStrengths: string[];
  userGaps: string[];
  groupAverageSkills: string[];
  recommendation: string;
}> {
  const model = nextGoogleGenerativeAI().getGenerativeModel({ model: getGeminiModelId() });
  const system = `You are a career advisor doing an anonymous skill gap analysis. Given one user's KB and a list of anonymized peer KBs (no names), compare the user's skills, projects, and experience to the group. Return ONLY JSON: { "userStrengths": [string], "userGaps": [string], "groupAverageSkills": [string], "recommendation": string }. Do not add explanation or markdown.`;

  const prompt = `${system}

User's KB:
${JSON.stringify(userKb, null, 2)}

Anonymized peer KBs:
${JSON.stringify(peerAnonKbs, null, 2)}

Target role: ${targetRole}`;

  const result = await withTimeout(model.generateContent(prompt), TIMEOUT_MS);
  const raw = result.response.text().trim();
  const parsed = JSON.parse(extractJSON(raw)) as {
    userStrengths?: string[];
    userGaps?: string[];
    groupAverageSkills?: string[];
    recommendation?: string;
  };

  return {
    userStrengths: Array.isArray(parsed.userStrengths) ? parsed.userStrengths.map(String).slice(0, 8) : [],
    userGaps: Array.isArray(parsed.userGaps) ? parsed.userGaps.map(String).slice(0, 8) : [],
    groupAverageSkills: Array.isArray(parsed.groupAverageSkills)
      ? parsed.groupAverageSkills.map(String).slice(0, 12)
      : [],
    recommendation: String(parsed.recommendation || ''),
  };
}
