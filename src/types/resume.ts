export interface ReasoningEntry {
  item: string;
  reason: string;
}

export interface RefinedResumeReasoning {
  included?: ReasoningEntry[];
  excluded?: ReasoningEntry[];
}

export interface RefinedExperience {
  company?: string;
  role?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  description?: string[];
  techStack?: string[];
}

export interface RefinedEducation {
  institution?: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  cgpa?: string;
}

export interface RefinedProject {
  name?: string;
  description?: string;
  techStack?: string[];
  highlights?: string[];
  date?: string;
}

export interface RefinedSkills {
  technical?: string[];
  tools?: string[];
  languages?: string[];
  soft?: string[];
}

export interface RefinedCertification {
  name?: string;
  issuer?: string;
  date?: string;
}

export interface RefinedAchievement {
  title?: string;
  description?: string;
  date?: string;
}

/** Snapshot diff when regenerating tailored resume vs previous version. */
export interface ResumeDiffRow {
  area: string;
  before: string;
  after: string;
}

export interface RefinedResume {
  targetRole?: string;
  summary?: string;
  education?: RefinedEducation[];
  experience?: RefinedExperience[];
  projects?: RefinedProject[];
  skills?: RefinedSkills;
  certifications?: RefinedCertification[];
  achievements?: RefinedAchievement[];
  publications?: { title?: string; venue?: string; date?: string }[];
  reasoning?: RefinedResumeReasoning;
}

export interface ATSScoreResult {
  score: number;
  missingKeywords: string[];
  presentKeywords: string[];
  suggestions: string[];
}

export interface JobFitResult {
  overallFit: number;
  strengths: string[];
  gaps: string[];
  verdict: string;
}
