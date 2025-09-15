import  type{ Request, Response } from 'express';
import { audit } from '../lib/audit.js';
import { sendSupabaseInvite, riHash, sbRest, getAuthUser, supabaseAdmin } from '../lib/supabase.js';
import { validatePasswordPolicy } from '../lib/passwordPolicy.js';
import crypto from 'crypto';

async function isAdminUser(req: Request) {
  const user = await getAuthUser(req.headers.authorization as string | undefined);
  if (!user) {
    // eslint-disable-next-line no-console
    console.log('[isAdminUser] no auth user');
    return false;
  }
  // eslint-disable-next-line no-console
  console.log('[isAdminUser] user', user.id);
  const rows = await sbRest(`/staff?user_id=eq.${user.id}&select=role`, { method: 'GET' });
  const role = rows?.[0]?.role as string | undefined;
  const ok = !!role && (role === 'owner' || role === 'staff');
  // eslint-disable-next-line no-console
  console.log('[isAdminUser] staff rows', Array.isArray(rows) ? rows.length : 0, 'role', role, 'isAdmin', ok);
  return ok;
}

export async function reissueInvite(req: Request, res: Response) {
  try {
    const { ri } = req.body || {};
    if (!ri) return res.status(400).json({ status: 'invalid' });
    const hash = riHash(String(ri));
    const rows = (await sbRest(`/invites?select=*&ri_token_hash=eq.${hash}`, { method: 'GET' })) as any[];
    const invite = rows?.[0];
    if (!invite) {
      await audit('invite.invalid_ri', { ri: 'not_found' });
      return res.json({ status: 'invalid' });
    }
    const count = Number(invite.reissue_count || 0);
    if (count >= 5) {
      await audit('invite.blocked', { user_id: invite.user_id, email: invite.email, reissue_count: count });
      return res.json({ status: 'blocked' });
    }
    // Send invite via Supabase (email delivery handled by Supabase). Include our RI for future reissues.
    await sendSupabaseInvite(invite.email, `?ri=${ri}`);
    const next = {
      last_sent_at: new Date().toISOString(),
      reissue_count: count + 1,
      send_count: Number(invite.send_count || 0) + 1
    };
    await sbRest(`/invites?ri_token_hash=eq.${hash}`, { method: 'PATCH', body: JSON.stringify(next) });
    await audit('invite.reissue', { user_id: invite.user_id, email: invite.email, reissue_count: next.reissue_count });
    res.json({ status: 'sent' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function validatePassword(req: Request, res: Response) {
  try {
    const { password } = req.body || {};
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    const email = user?.email ?? undefined;
    const result = validatePasswordPolicy(String(password || ''), email);
    if (!result.ok) return res.json({ ok: false, errorCode: 'WEAK_PASSWORD', errors: result.errors });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function passwordChangeAudit(req: Request, res: Response) {
  try {
    const { method } = req.body || {};
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    await audit('auth.password_change', { method, user_id: user?.id });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function whoami(req: Request, res: Response) {
  try {
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    console.log(user)
    if (!user) return res.json({ isAdmin: false, role: null, user: null });
    // eslint-disable-next-line no-console
    console.log('[whoami] user', user.id, user.email);
    const rows = await sbRest(`/staff?user_id=eq.${user.id}&select=role`, { method: 'GET' });
    const role = rows?.[0]?.role as string | undefined;
    const isAdmin = !!role && (role === 'owner' || role === 'staff');
    // Try to read display_name from auth.users (service role)
    let display_name: string | null = null;
    try {
      const urows = await sbRest(`/users?id=eq.${user.id}&select=display_name`, { method: 'GET', headers: { 'Accept-Profile': 'auth' } });
      const d = Array.isArray(urows) ? urows[0] : null;
      display_name = (d && d.display_name) ? String(d.display_name) : null;
    } catch {}
    // eslint-disable-next-line no-console
    console.log('[whoami] staff rows', Array.isArray(rows) ? rows.length : 0, 'role', role, 'isAdmin', isAdmin);
    res.json({ isAdmin, role: role || null, user: { id: user.id, email: user.email, display_name } });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function createInvite(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin only' });
    const { email, name, invitedAs } = req.body || {} as { email?: string; name?: string; invitedAs?: 'org' | 'staff' | 'owner' };
    const roleOk = invitedAs === 'org' || invitedAs === 'staff' || invitedAs === 'owner';
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!roleOk) return res.status(400).json({ error: 'invitedAs required' });

    const ri = crypto.randomBytes(16).toString('hex');
    const hash = riHash(ri);
    const now = new Date().toISOString();

    // Send invite via Supabase (returns the created auth user id)
    const inviteRes = await sendSupabaseInvite(email, `?ri=${ri}`, name ? { name, display_name: name } : undefined);
    const user_id = inviteRes?.invitedUserId || null;

    // Insert or update our invites ledger with user_id populated
    try {
      await sbRest('/invites', {
        method: 'POST',
        body: JSON.stringify([
          {
            user_id,
            email,
            ri_token_hash: hash,
            status: 'pending',
            send_count: 1,
            reissue_count: 0,
            last_sent_at: now,
            created_at: now,
            // metadata for provisioning after password set
            invited_as: invitedAs,
            target_name: name
          }
        ])
      });
    } catch (_e) {
      const rows = await sbRest(`/invites?email=eq.${encodeURIComponent(email)}&select=send_count`, { method: 'GET' });
      const sendCount = Number(rows?.[0]?.send_count || 0) + 1;
      await sbRest(`/invites?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ri_token_hash: hash, status: 'pending', last_sent_at: now, send_count: sendCount, reissue_count: 0, user_id, invited_as: invitedAs, target_name: name })
      });
    }

    await audit('invite.create', { email });
    res.json({ status: 'sent' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function finalizeInvite(req: Request, res: Response) {
  try {
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    // Find invite by user_id first (most reliable), else by email
    let rows = (await sbRest(`/invites?select=invited_as,target_name,email,status&user_id=eq.${user.id}`, { method: 'GET' })) as any[];
    let invite = rows?.[0] || null;
    if (!invite && user.email) {
      rows = (await sbRest(`/invites?select=invited_as,target_name,email,status&email=eq.${encodeURIComponent(user.email)}`, { method: 'GET' })) as any[];
      invite = rows?.[0] || null;
    }
    if (!invite) return res.status(400).json({ error: 'invite_not_found' });
    const ia = String(invite.invited_as || '').toLowerCase();
    const nm = String(invite.target_name || '') || user.email;

    if (ia === 'org') {
      try { await sbRest('/orgs', { method: 'POST', body: JSON.stringify([{ id: user.id, name: nm }]) }); } catch {}
    } else if (ia === 'staff' || ia === 'owner') {
      try { await sbRest('/staff', { method: 'POST', body: JSON.stringify([{ user_id: user.id, role: ia }]) }); } catch {}
    }

    // Ensure auth.users metadata/display_name has the provided name for staff/owner display (and org users too)
    try {
      if (supabaseAdmin && nm) {
        await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { name: nm, display_name: nm } });
        try {
          await sbRest(`/users?id=eq.${user.id}`, { method: 'PATCH', headers: { 'Content-Profile': 'auth' }, body: JSON.stringify({ display_name: nm }) });
        } catch {}
      }
    } catch {}

    try { await sbRest(`/invites?email=eq.${encodeURIComponent(invite.email)}`, { method: 'PATCH', body: JSON.stringify({ status: 'accepted' }) }); } catch {}
    await audit('invite.finalize', { user_id: user.id, email: user.email, ia: ia || null });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function adminResendInvite(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin only' });
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });

    const rows = (await sbRest(`/invites?email=eq.${encodeURIComponent(email)}&select=ri_token_hash,reissue_count,send_count,status`, { method: 'GET' })) as any[];
    const invite = rows?.[0] || null;
    const count = Number(invite?.reissue_count || 0);
    if (count >= 5) {
      await audit('invite.blocked', { email, reissue_count: count });
      return res.json({ status: 'blocked' });
    }

    const ri = crypto.randomBytes(16).toString('hex');
    const hash = riHash(ri);
    const now = new Date().toISOString();
    const patch = {
      ri_token_hash: hash,
      last_sent_at: now,
      reissue_count: count + 1,
      send_count: Number(invite?.send_count || 0) + 1,
      status: 'pending'
    };
    await sbRest(`/invites?email=eq.${encodeURIComponent(email)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await sendSupabaseInvite(email, `?ri=${ri}`);
    await audit('invite.reissue', { email, reissue_count: patch.reissue_count });
    res.json({ status: 'sent' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function listInvites(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin only' });
    const rows = await sbRest(`/invites?select=email,status,last_sent_at,send_count,reissue_count,created_at&order=created_at.desc`, { method: 'GET' });
    res.json(rows || []);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

// Admin: list all orgs (id, name) for client mapping
export async function listOrgs(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin only' });
    const rows = await sbRest(`/orgs?select=id,name&order=name.asc`, { method: 'GET' });
    res.json(rows || []);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

// Update the authenticated user's display name (auth.users.display_name + metadata)
export async function updateDisplayName(req: Request, res: Response) {
  try {
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const { display_name } = (req.body || {}) as { display_name?: string };
    const dn = String(display_name || '').trim();
    if (!dn) return res.status(400).json({ error: 'display_name_required' });
    try {
      if (supabaseAdmin) {
        await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { display_name: dn, name: dn } });
      }
    } catch {}
    try {
      await sbRest(`/users?id=eq.${user.id}`, { method: 'PATCH', headers: { 'Content-Profile': 'auth' }, body: JSON.stringify({ display_name: dn }) });
    } catch {}
    await audit('auth.update_display_name', { user_id: user.id });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}
