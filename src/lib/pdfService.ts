import puppeteer from 'puppeteer';
import { RefinedResume } from '../types/resume';

export type ResumeTemplateId = 'minimal' | 'modern' | 'academic';

function esc(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FONT_LINK = `<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

function baseStyles(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Lora', Georgia, serif; font-size: 10pt; line-height: 1.45; color: #111; }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 8.5pt; color: #444; }
  ul { margin: 0.2em 0 0.4em 1.1em; padding: 0; }
  li { margin-bottom: 0.15em; }
`;
}

function skillsBlock(skills: RefinedResume['skills']): string {
  if (!skills) return '';
  const parts: string[] = [];
  if (skills.technical?.length) parts.push(`<strong>Technical:</strong> ${esc(skills.technical.join(', '))}`);
  if (skills.tools?.length) parts.push(`<strong>Tools:</strong> ${esc(skills.tools.join(', '))}`);
  if (skills.languages?.length) parts.push(`<strong>Languages:</strong> ${esc(skills.languages.join(', '))}`);
  if (skills.soft?.length) parts.push(`<strong>Soft:</strong> ${esc(skills.soft.join(', '))}`);
  return parts.join('<br/>');
}

export function buildResumeHtml(resume: RefinedResume, template: ResumeTemplateId): string {
  if (template === 'modern') return buildModernHtml(resume);
  if (template === 'academic') return buildAcademicHtml(resume);
  return buildMinimalHtml(resume);
}

function buildMinimalHtml(r: RefinedResume): string {
  const name = esc(r.targetRole ? `${r.targetRole}` : 'Resume');
  const exp = (r.experience ?? [])
    .map((e) => {
      const head = `${esc(e.role)} — ${esc(e.company)}`;
      const dates = `${esc(e.startDate ?? '')} – ${esc(e.endDate ?? 'Present')}`;
      const bullets = (e.description ?? []).map((d) => `<li>${esc(d)}</li>`).join('');
      return `<div style="margin-bottom:0.65em"><div style="display:flex;justify-content:space-between;border-bottom:1px solid #000;padding-bottom:2px;margin-bottom:0.25em"><strong>${head}</strong><span class="mono">${dates}</span></div>${bullets ? `<ul>${bullets}</ul>` : ''}</div>`;
    })
    .join('');

  const edu = (r.education ?? [])
    .map((e) => `<div class="mono" style="margin-bottom:0.35em">${esc(e.degree)} · ${esc(e.institution)} · ${esc(e.startDate ?? '')} – ${esc(e.endDate ?? '')}</div>`)
    .join('');

  const proj = (r.projects ?? [])
    .map((p) => {
      const bullets = (p.highlights ?? []).map((h) => `<li>${esc(h)}</li>`).join('');
      return `<div style="margin-bottom:0.5em"><strong>${esc(p.name)}</strong>${p.description ? ` — ${esc(p.description)}` : ''}${bullets ? `<ul>${bullets}</ul>` : ''}</div>`;
    })
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${FONT_LINK}<style>${baseStyles()}
  h1 { font-size: 22pt; font-weight: 700; letter-spacing: 0.02em; margin-bottom: 0.15em; }
  .rule { border: none; border-top: 1px solid #000; margin: 0.4em 0 0.6em; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.12em; margin: 0.9em 0 0.35em; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  </style></head><body>
  <h1>${name}</h1>
  ${r.summary ? `<p style="margin-bottom:0.5em">${esc(r.summary)}</p>` : ''}
  <hr class="rule"/>
  ${r.experience?.length ? `<h2>Experience</h2>${exp}` : ''}
  ${r.education?.length ? `<h2>Education</h2>${edu}` : ''}
  ${r.projects?.length ? `<h2>Projects</h2>${proj}` : ''}
  ${skillsBlock(r.skills) ? `<h2>Skills</h2><p>${skillsBlock(r.skills)}</p>` : ''}
  </body></html>`;
}

function buildModernHtml(r: RefinedResume): string {
  const exp = (r.experience ?? [])
    .map((e) => {
      const bullets = (e.description ?? []).map((d) => `<li>${esc(d)}</li>`).join('');
      return `<div style="margin-bottom:0.55em"><div style="font-weight:700">${esc(e.role)}</div><div class="mono" style="color:#555">${esc(e.company)} · ${esc(e.startDate ?? '')} – ${esc(e.endDate ?? '')}</div>${bullets ? `<ul>${bullets}</ul>` : ''}</div>`;
    })
    .join('');

  const leftEdu = (r.education ?? [])
    .map((e) => `<div style="margin-bottom:0.45em"><strong>${esc(e.institution)}</strong><br/><span class="mono">${esc(e.degree)}</span></div>`)
    .join('');

  const leftSkills = skillsBlock(r.skills);

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${FONT_LINK}<style>${baseStyles()}
  .wrap { display: flex; gap: 4%; }
  .sidebar { width: 30%; background: #EEF3EE; padding: 14px 12px; min-height: 100%; }
  .main { width: 66%; padding: 14px 0; }
  h1 { font-size: 20pt; margin-bottom: 0.2em; }
  .target { font-size: 11pt; color: #4D6E53; font-weight: 600; margin-bottom: 0.5em; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.1em; color: #4D6E53; margin: 0.75em 0 0.3em; border-bottom: 1px solid #6B8F71; padding-bottom: 2px; }
  .sidebar h2 { color: #2d4a32; border-color: #6B8F71; }
  </style></head><body>
  <div class="wrap">
    <div class="sidebar">
      <h2>Education</h2>${leftEdu || '<p class="mono">—</p>'}
      <h2>Skills</h2>${leftSkills ? `<div style="font-size:9pt">${leftSkills}</div>` : '<p class="mono">—</p>'}
      ${r.certifications?.length ? `<h2>Certifications</h2>${r.certifications.map((c) => `<div style="font-size:9pt;margin-bottom:0.3em">${esc(c.name)}${c.issuer ? ` · ${esc(c.issuer)}` : ''}</div>`).join('')}` : ''}
    </div>
    <div class="main">
      <h1>${esc(r.targetRole || 'Candidate')}</h1>
      ${r.summary ? `<p style="margin-bottom:0.6em;line-height:1.5">${esc(r.summary)}</p>` : ''}
      <h2>Experience</h2>${exp || '<p class="mono">—</p>'}
      ${r.projects?.length ? `<h2>Projects</h2>${r.projects.map((p) => `<div style="margin-bottom:0.45em"><strong>${esc(p.name)}</strong>${p.description ? `<br/>${esc(p.description)}` : ''}</div>`).join('')}` : ''}
    </div>
  </div>
  </body></html>`;
}

function buildAcademicHtml(r: RefinedResume): string {
  const pubs = r.publications ?? [];
  const pubBlock = pubs.length
    ? `<h2>Publications</h2><ol style="margin-left:1.2em">${pubs.map((p) => `<li style="margin-bottom:0.35em">${esc(p.title)}${p.venue ? ` — <span class="mono">${esc(p.venue)}</span>` : ''}${p.date ? ` <span class="mono">(${esc(p.date)})</span>` : ''}</li>`).join('')}</ol>`
    : '';

  const exp = (r.experience ?? [])
    .map((e) => {
      const bullets = (e.description ?? []).map((d) => `<li>${esc(d)}</li>`).join('');
      return `<div style="margin-bottom:0.55em"><div><strong>${esc(e.role)}</strong>, ${esc(e.company)} <span class="mono">(${esc(e.startDate ?? '')}–${esc(e.endDate ?? '')})</span></div>${bullets ? `<ul>${bullets}</ul>` : ''}</div>`;
    })
    .join('');

  const edu = (r.education ?? [])
    .map((e) => `<div style="margin-bottom:0.35em">${esc(e.degree)} in ${esc(e.field || '')}, ${esc(e.institution)}, ${esc(e.startDate ?? '')}–${esc(e.endDate ?? '')}</div>`)
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${FONT_LINK}<style>${baseStyles()}
  h1 { font-size: 14pt; text-align:center; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:0.15em; }
  .sub { text-align:center; font-size:9pt; margin-bottom:0.6em; }
  h2 { font-size:10pt; margin:0.85em 0 0.35em; border-bottom:1px solid #000; padding-bottom:1px; text-transform:uppercase; letter-spacing:0.06em; }
  </style></head><body>
  <h1>${esc(r.targetRole || 'Curriculum Vitae')}</h1>
  <div class="sub mono">Research &amp; Professional Summary</div>
  ${r.summary ? `<p style="text-align:justify;margin-bottom:0.5em">${esc(r.summary)}</p>` : ''}
  <h2>Education</h2>${edu}
  <h2>Experience</h2>${exp}
  ${r.projects?.length ? `<h2>Projects</h2><ul>${r.projects.map((p) => `<li><strong>${esc(p.name)}</strong>${p.description ? ` — ${esc(p.description)}` : ''}</li>`).join('')}</ul>` : ''}
  ${skillsBlock(r.skills) ? `<h2>Technical Skills</h2><p>${skillsBlock(r.skills)}</p>` : ''}
  ${pubBlock}
  </body></html>`;
}

export function buildCoverLetterHtml(body: string): string {
  const safe = esc(body).replace(/\n/g, '<br/>');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${FONT_LINK}<style>${baseStyles()}
  body { padding: 0; max-width: 100%; }
  p { margin-bottom: 0.75em; text-align: justify; }
  </style></head><body><div style="font-size:11pt;line-height:1.55">${safe}</div></body></html>`;
}

export async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '18mm', right: '18mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function renderResumePdf(
  resume: RefinedResume,
  template: ResumeTemplateId
): Promise<Buffer> {
  const html = buildResumeHtml(resume, template);
  return htmlToPdfBuffer(html);
}

export async function renderCoverLetterPdf(text: string): Promise<Buffer> {
  return htmlToPdfBuffer(buildCoverLetterHtml(text));
}
