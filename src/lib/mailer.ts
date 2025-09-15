import fs from 'fs';
import path from 'path';

export function loadTemplate(name: string): string {
  const p = path.join(__dirname, '..', 'templates', name);
  return fs.readFileSync(p, 'utf8');
}

export async function sendMail(opts: { to: string; subject: string; html: string }) {
  // Stub for now; SMTP wiring later.
  // eslint-disable-next-line no-console
  console.log(`[mailer] To:${opts.to} Subject:${opts.subject}`);
  return { ok: true } as const;
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(.*?)\}\}/g, (_, k) => vars[k.trim()] ?? '');
}

