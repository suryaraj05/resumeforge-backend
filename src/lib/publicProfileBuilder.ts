import { KnowledgeBase } from '../types/kb';

export interface PublicProfilePayload {
  username: string;
  displayName: string;
  headline: string;
  skills: string[];
  projects: { name?: string; techStack?: string[]; link?: string; description?: string }[];
  education: { institution?: string; degree?: string; field?: string }[];
  achievements: { title?: string; description?: string }[];
  showContact: boolean;
  contact?: { email?: string; linkedin?: string; github?: string };
}

function headlineFromKb(kb: KnowledgeBase): string {
  const parts: string[] = [];
  const edu = kb.education?.[0];
  if (edu?.degree || edu?.field) {
    parts.push([edu.degree, edu.field].filter(Boolean).join(' ').trim() || 'Student');
  } else {
    parts.push('Student');
  }
  const skills = [
    ...(kb.skills?.technical ?? []).slice(0, 3),
    ...(kb.skills?.tools ?? []).slice(0, 2),
  ];
  if (skills.length) parts.push(skills.join(', '));
  const nProj = kb.projects?.length ?? 0;
  if (nProj) parts.push(`${nProj} project${nProj === 1 ? '' : 's'}`);
  return parts.join(' | ');
}

export function buildPublicProfile(
  username: string,
  displayName: string,
  kb: KnowledgeBase | null,
  showContact: boolean
): PublicProfilePayload {
  const personal = kb?.personal;
  const name = personal?.name || displayName;

  const skills = [
    ...(kb?.skills?.technical ?? []),
    ...(kb?.skills?.tools ?? []),
    ...(kb?.skills?.languages ?? []),
  ].slice(0, 24);

  return {
    username,
    displayName: name,
    headline: kb ? headlineFromKb(kb) : displayName,
    skills,
    projects: (kb?.projects ?? []).slice(0, 8).map((p) => ({
      name: p.name,
      techStack: p.techStack,
      link: p.link,
      description: p.description,
    })),
    education: (kb?.education ?? []).slice(0, 4).map((e) => ({
      institution: e.institution,
      degree: e.degree,
      field: e.field,
    })),
    achievements: (kb?.achievements ?? []).slice(0, 6).map((a) => ({
      title: a.title,
      description: a.description,
    })),
    showContact,
    contact: showContact
      ? {
          email: personal?.email,
          linkedin: personal?.linkedin,
          github: personal?.github,
        }
      : undefined,
  };
}
