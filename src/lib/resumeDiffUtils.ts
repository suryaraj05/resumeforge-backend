import type { RefinedResume, ResumeDiffRow } from '../types/resume';

function expLabel(e: { company?: string; role?: string }, i: number): string {
  const c = (e.company ?? '').trim() || '(company)';
  const r = (e.role ?? '').trim() || '(role)';
  return `${i + 1}. ${c} — ${r}`;
}

function projNames(r: RefinedResume): string {
  return (r.projects ?? [])
    .map((p) => (p.name ?? '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('; ');
}

/** High-level before/after lines for tailored resume regeneration. */
export function computeResumeDiffSnapshot(before: RefinedResume, after: RefinedResume): ResumeDiffRow[] {
  const rows: ResumeDiffRow[] = [];

  const bSumm = (before.summary ?? '').slice(0, 160);
  const aSumm = (after.summary ?? '').slice(0, 160);
  if (bSumm !== aSumm) {
    rows.push({
      area: 'Summary',
      before: bSumm || '(empty)',
      after: aSumm || '(empty)',
    });
  }

  const bRole = (before.targetRole ?? '').trim();
  const aRole = (after.targetRole ?? '').trim();
  if (bRole !== aRole) {
    rows.push({ area: 'Target role', before: bRole || '(none)', after: aRole || '(none)' });
  }

  const be = before.experience ?? [];
  const ae = after.experience ?? [];
  if (be.length !== ae.length) {
    rows.push({
      area: 'Experience count',
      before: String(be.length),
      after: String(ae.length),
    });
  }
  const maxE = Math.max(be.length, ae.length);
  for (let i = 0; i < maxE; i++) {
    const b = be[i];
    const a = ae[i];
    if (!b && a) {
      rows.push({ area: `Experience ${i + 1}`, before: '(none)', after: expLabel(a, i) });
    } else if (b && !a) {
      rows.push({ area: `Experience ${i + 1}`, before: expLabel(b, i), after: '(removed)' });
    } else if (b && a) {
      const bl = expLabel(b, i);
      const al = expLabel(a, i);
      const bDesc = (b.description ?? []).join(' ').slice(0, 120);
      const aDesc = (a.description ?? []).join(' ').slice(0, 120);
      if (bl !== al || bDesc !== aDesc) {
        rows.push({
          area: `Experience ${i + 1}`,
          before: `${bl} — ${bDesc || '…'}`,
          after: `${al} — ${aDesc || '…'}`,
        });
      }
    }
  }

  const bp = before.projects ?? [];
  const ap = after.projects ?? [];
  if (bp.length !== ap.length || projNames(before) !== projNames(after)) {
    rows.push({
      area: 'Projects',
      before: `${bp.length}: ${projNames(before) || '—'}`,
      after: `${ap.length}: ${projNames(after) || '—'}`,
    });
  }

  const bTech = (before.skills?.technical ?? []).length;
  const aTech = (after.skills?.technical ?? []).length;
  if (bTech !== aTech) {
    rows.push({
      area: 'Technical skills count',
      before: String(bTech),
      after: String(aTech),
    });
  }

  return rows.slice(0, 24);
}
