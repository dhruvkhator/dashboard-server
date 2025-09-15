import type { Request, Response } from 'express';
import { audit } from '../lib/audit.js';
import { sbRest, getAuthUser } from '../lib/supabase.js';

function computeExpiry(duration?: string, fixedTtlHours?: number) {
  if (!duration || duration === 'until_revoked') return null;
  const hours = duration === 'fixed' ? (fixedTtlHours || 24) : 72; // sliding default 72h
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export async function requestAccess(req: Request, res: Response) {
  try {
    const { targetOrgId, agentIds, scopes, reason, duration, fixedTtlHours } = req.body || {};
    const actor = await getAuthUser(req.headers.authorization as string | undefined);
    const parent = {
      target_org_id: targetOrgId,
      scopes: scopes || [],
      status: 'pending',
      requested_reason: reason || null,
      granted_at: new Date().toISOString(),
      granted_to_user_id: actor?.id || null,
      duration: duration || 'until_revoked',
      expires_at: computeExpiry(duration, fixedTtlHours)
    };
    const inserted = await sbRest('/edit_access_grants', { method: 'POST', body: JSON.stringify([parent]) });
    const grant = inserted?.[0] || parent;
    const children = (agentIds || []).map((agent_id: string) => ({ grant_id: grant.id, agent_id }));
    if (children.length) {
      await sbRest('/edit_access_grant_agents', { method: 'POST', body: JSON.stringify(children) });
    }
    await audit('edit_access.request', { grant_id: grant.id, target_org_id: targetOrgId, scopes });
    res.json(grant);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function approveAccess(req: Request, res: Response) {
  try {
    const { grantId, method, duration, fixedTtlHours } = req.body || {};
    const patch = {
      status: 'active',
      approval_channel: method || 'unknown',
      duration: duration || 'until_revoked',
      expires_at: computeExpiry(duration, fixedTtlHours)
    };
    const rows = await sbRest(`/edit_access_grants?id=eq.${grantId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const updated = rows?.[0] || { id: grantId, ...patch };
    await audit('edit_access.approve', { grant_id: grantId, method });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function revokeAccess(req: Request, res: Response) {
  try {
    const { grantId, reason } = req.body || {};
    const patch = { status: 'revoked', revoke_reason: reason || null } as any;
    const rows = await sbRest(`/edit_access_grants?id=eq.${grantId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const updated = rows?.[0] || { id: grantId, ...patch };
    await audit('edit_access.revoke', { grant_id: grantId, reason });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}

export async function sweepExpiredGrants() {
  // Cron-like function: find active but expired and flip; we keep it callable from a scheduler later.
  const now = new Date().toISOString();
  const rows = await sbRest(`/rpc/expire_edit_access_grants`, { method: 'POST', body: JSON.stringify({ now }) }).catch(() => null);
  if (Array.isArray(rows)) {
    for (const r of rows) await audit('edit_access.expire', { grant_id: r.id });
  }
}

export async function activeFor(req: Request, res: Response) {
  try {
    const { agentIds, scope } = req.body || {};
    const user = await getAuthUser(req.headers.authorization as string | undefined);
    if (!user || !Array.isArray(agentIds) || agentIds.length === 0) return res.json({ agentIds: [] });

    // Find child rows for these agents
    const idsLiteral = agentIds.map((id: string) => `"${id}"`).join(',');
    const children = await sbRest(`/edit_access_grant_agents?agent_id=in.(${idsLiteral})&select=grant_id,agent_id`, { method: 'GET' });
    const mapByAgent = new Map<string, string[]>();
    const grantIds: string[] = [];
    for (const c of children || []) {
      const list = mapByAgent.get(c.agent_id) || [];
      list.push(c.grant_id);
      mapByAgent.set(c.agent_id, list);
      grantIds.push(c.grant_id);
    }
    if (grantIds.length === 0) return res.json({ agentIds: [] });

    const now = new Date().toISOString();
    const scopeLiteral = `{${scope || 'agent.update'}}`;
    const parents = await sbRest(
      `/edit_access_grants?select=id&` +
        `id=in.(${Array.from(new Set(grantIds)).join(',')})&` +
        `status=eq.active&` +
        `granted_to_user_id=eq.${user.id}&` +
        `or=(expires_at.is.null,expires_at.gt.${now})&` +
        `scopes=cs.${scopeLiteral}`,
      { method: 'GET' }
    );
    const okParentIds = new Set((parents || []).map((p: any) => p.id));
    const allowedAgents: string[] = [];
    for (const [agentId, gids] of mapByAgent) {
      if (gids.some((g) => okParentIds.has(g))) allowedAgents.push(agentId);
    }
    res.json({ agentIds: allowedAgents });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server_error' });
  }
}
