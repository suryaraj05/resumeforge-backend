export interface KBPersonal {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  summary?: string;
}

export interface KBEducation {
  id: string;
  institution?: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  cgpa?: string;
  achievements?: string[];
}

export interface KBExperience {
  id: string;
  company?: string;
  role?: string;
  type?: 'internship' | 'full-time' | 'part-time' | 'contract';
  startDate?: string;
  endDate?: string;
  description?: string[];
  techStack?: string[];
}

export interface KBProject {
  id: string;
  name?: string;
  description?: string;
  techStack?: string[];
  link?: string;
  highlights?: string[];
  date?: string;
}

export interface KBSkills {
  technical?: string[];
  tools?: string[];
  languages?: string[];
  soft?: string[];
}

export interface KBCertification {
  id: string;
  name?: string;
  issuer?: string;
  date?: string;
  link?: string;
}

export interface KBAchievement {
  id: string;
  title?: string;
  description?: string;
  date?: string;
}

export interface KBPublication {
  id: string;
  title?: string;
  venue?: string;
  date?: string;
  link?: string;
}

export interface KnowledgeBase {
  userId: string;
  lastUpdated: string;
  version: number;
  personal?: KBPersonal;
  education?: KBEducation[];
  experience?: KBExperience[];
  projects?: KBProject[];
  skills?: KBSkills;
  certifications?: KBCertification[];
  achievements?: KBAchievement[];
  publications?: KBPublication[];
}

export type GeminiKBResponse = Omit<KnowledgeBase, 'userId' | 'lastUpdated' | 'version'>;
