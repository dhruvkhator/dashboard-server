import type { Request } from 'express';

export function getRequestIp(req: Request): string {
  const forwarded = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '') as string | string[];
  if (Array.isArray(forwarded)) {
    const first = forwarded[0];
    if (typeof first === 'string' && first.length) return first.trim();
  }
  if (typeof forwarded === 'string' && forwarded.length) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const ip = req.ip || (req.socket && 'remoteAddress' in req.socket ? req.socket.remoteAddress : null);
  return typeof ip === 'string' && ip.length ? ip : '0.0.0.0';
}

export function getOriginFromHeaders(req: Request): { origin: string | null; host: string | null } {
  const originHeader = (req.headers.origin || req.headers.referer) as string | undefined;
  if (!originHeader) return { origin: null, host: null };
  try {
    const url = new URL(originHeader);
    return { origin: url.origin, host: url.host.toLowerCase() };
  } catch {
    return { origin: null, host: null };
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function isDomainAllowed(host: string | null, domains: string[] | null | undefined): boolean {
  if (!host) return false;
  if (!domains || !domains.length) return false;
  const needle = host.toLowerCase();
  for (const raw of domains) {
    const domain = normalizeDomain(String(raw || ''));
    if (!domain) continue;
    if (domain === needle) return true;
    if (domain.startsWith('*.')) {
      const suffix = domain.slice(2);
      if (needle === suffix) return true;
      if (needle.endsWith('.' + suffix)) return true;
    }
  }
  return false;
}

export function ensureAllowedDomain(req: Request, agent: { domains?: string[] }, strict = true): { origin: string | null; host: string | null } {
  const info = getOriginFromHeaders(req);
  if (!info.host) {
    if (strict) {
      const err = new Error('origin_required');
      (err as any).status = 400;
      throw err;
    }
    return info;
  }
  const allowed = isDomainAllowed(info.host, agent.domains as string[] | undefined);
  if (!allowed) {
    const err = new Error('origin_not_allowed');
    (err as any).status = 403;
    throw err;
  }
  return info;
}

export function getRequestId(req: Request): string | null {
  const rid = req.headers['x-request-id'];
  if (Array.isArray(rid)) return rid[0] || null;
  return typeof rid === 'string' && rid.length ? rid : null;
}

export function getDeviceRand(req: Request): string | null {
  const value = req.headers['x-device-rand'];
  if (Array.isArray(value)) return value[0] || null;
  return typeof value === 'string' && value.length ? value : null;
}

export function isPageLoad(req: Request): boolean {
  const flag = req.headers['x-page-load'];
  if (flag === undefined) return false;
  if (Array.isArray(flag)) return flag.includes('1');
  return flag === '1' || flag === 'true';
}
