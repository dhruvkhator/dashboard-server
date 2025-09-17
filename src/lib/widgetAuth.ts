import crypto from 'crypto';
import type { Request } from 'express';
import { getRequestId } from './widgetUtils.js';

const SIGNATURE_SECRET = process.env.WIDGET_HMAC_SECRET;
const SIGNATURE_TTL_MS = Number(process.env.WIDGET_SIGNATURE_TTL_MS || 60000);
const NONCE_CACHE_MAX = Number(process.env.WIDGET_NONCE_CACHE_MAX || 50000);

const nonceCache = new Map<string, number>();

function cleanupNonces(now: number) {
  if (nonceCache.size <= NONCE_CACHE_MAX) return;
  for (const [key, expires] of nonceCache) {
    if (expires <= now) {
      nonceCache.delete(key);
    }
  }
}

function getHeader(req: Request, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || null;
  if (typeof value === 'string' && value.length) return value;
  return null;
}

export function verifyWidgetSignature(req: Request, payload: { publicId: string }): void {
  if (!SIGNATURE_SECRET) {
    throw Object.assign(new Error('signature_secret_missing'), { status: 500 });
  }

  const ts = getHeader(req, 'x-cw-timestamp');
  const nonce = getHeader(req, 'x-cw-nonce');
  const signature = getHeader(req, 'x-cw-signature');

  if (!ts || !nonce || !signature) {
    const err = new Error('signature_headers_required');
    (err as any).status = 400;
    throw err;
  }

  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) {
    const err = new Error('invalid_timestamp');
    (err as any).status = 400;
    throw err;
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > SIGNATURE_TTL_MS) {
    const err = new Error('signature_expired');
    (err as any).status = 401;
    throw err;
  }

  const nonceKey = payload.publicId + ':' + nonce;
  const existing = nonceCache.get(nonceKey);
  if (existing && existing > now) {
    const err = new Error('nonce_reused');
    (err as any).status = 401;
    throw err;
  }

  const base = payload.publicId + '.' + String(timestamp) + '.' + nonce;
  const expected = crypto.createHmac('sha256', SIGNATURE_SECRET).update(base).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    const err = new Error('signature_invalid_format');
    (err as any).status = 400;
    throw err;
  }

  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    const err = new Error('signature_mismatch');
    (err as any).status = 401;
    throw err;
  }

  nonceCache.set(nonceKey, now + SIGNATURE_TTL_MS);
  cleanupNonces(now);
}

export function computeDeviceFingerprint(ip: string, userAgent: string | undefined, rand: string): string {
  const secret = process.env.DEVICE_FINGERPRINT_SECRET || SIGNATURE_SECRET;
  if (!secret) throw new Error('device_fingerprint_secret_missing');
  const ua = userAgent || '';
  const input = ip + '|' + ua + '|' + rand;
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

export function buildAuditContext(req: Request): Record<string, any> {
  return {
    ip: req.ip,
    forwarded: req.headers['x-forwarded-for'] || null,
    request_id: getRequestId(req)
  };
}
