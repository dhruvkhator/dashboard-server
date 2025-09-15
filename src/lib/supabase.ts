import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config()

export const SUPABASE_URL = process.env.SUPABASE_URL as string | undefined;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined;
export const RI_SECRET = process.env.RI_SECRET as string | undefined;
export const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const DEBUG_SUPABASE = process.env.DEBUG_SUPABASE === '1';
const dbg = (...args: any[]) => { if (DEBUG_SUPABASE) console.log('[supabase]', ...args); };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env');
}
dbg(`Config: url=${SUPABASE_URL ? 'set' : 'missing'}, service_key=${SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'missing'}, client_url=${CLIENT_URL}`);

// Admin SDK client (service-role)
export const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export function riHash(ri: string) {
  if (!RI_SECRET) throw new Error('RI_SECRET not configured');
  return crypto.createHmac('sha256', RI_SECRET).update(ri).digest('hex');
}

export async function sbRest(path: string, init?: any) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  dbg('REST', init?.method || 'GET', path);
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY || '',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  } as any);
  dbg('REST status', res.status);
  if (!res.ok) {
    const text = await res.text();
    dbg('REST error body', text?.slice(0, 300) || '(empty)');
    throw new Error(text || `Supabase REST error: ${res.status}`);
  }
  // In some cases PostgREST returns empty
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text as any; }
}

export async function generateInviteLink(email: string, redirectQuery?: string) {
  const url = `${SUPABASE_URL}/auth/v1/admin/generate_link`;
  dbg('Auth admin generate_link for', email);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY || '',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'invite',
      email,
      options: { redirect_to: `${CLIENT_URL}/auth/invite${redirectQuery || ''}` }
    })
  } as any);
  dbg('generate_link status', res.status);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `generate_link failed: ${res.status}`);
  }
  const data = await res.json();
  return data?.action_link as string | undefined;
}

export async function sendSupabaseInvite(email: string, redirectQuery?: string, metadata?: Record<string, any>) {
  const redirect_to = `${CLIENT_URL}/auth/invite${redirectQuery || ''}`;
  dbg('SDK invite for', email, 'redirect', redirect_to);
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const options: { redirectTo?: string; data?: object } = { redirectTo: redirect_to };
  if (metadata) options.data = metadata as object;
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, options);
  if (error) {
    dbg('SDK invite error', error.message);
    throw new Error(error.message || 'invite send failed');
  }
  const invitedUserId = (data as any)?.user?.id || (data as any)?.id;
  dbg('SDK invite ok user_id', invitedUserId || '(unknown)');
  return { invitedUserId } as const;
}

export async function getAuthUser(authorization?: string) {
  if (!authorization) return null;
  const url = `${SUPABASE_URL}/auth/v1/user`;
  dbg('Auth user lookup');
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authorization,
      apikey: SUPABASE_SERVICE_ROLE_KEY || ''
    }
  } as any);
  dbg('user lookup status', res.status);
  if (!res.ok) return null;
  const data = await res.json();
  return data as { id: string; email: string } | null;
}
