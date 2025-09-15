import type { Request, Response } from 'express';
import { audit } from '../lib/audit.js';
import { sbRest, getAuthUser } from '../lib/supabase.js';

function randomId(len = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function getAgent(agentId: string) {
  const rows = await sbRest(`/agents?id=eq.${agentId}&select=*`, { method: 'GET' });
  return rows?.[0] || null;
}

async function hasGrantFor(req: Request, agentId: string, requiredScope: 'agent.update' | 'theme.update') {
  const user = await getAuthUser(req.headers.authorization as string | undefined);
  if (!user) return false;
  // Client shortcut: if this agent belongs to the actor's org, allow without grant
  try {
    const agent = await getAgent(agentId);
    if (agent && agent.org_id === user.id) return true;
  } catch {}
  // Find grants that include this agent
  const children = await sbRest(`/edit_access_grant_agents?agent_id=eq.${agentId}&select=grant_id`, { method: 'GET' });
  const grantIds: string[] = (children || []).map((c: any) => c.grant_id);
  if (!grantIds.length) return false;
  const now = new Date().toISOString();
  // Filter parent grants by active + actor + not expired + scopes contains required
  // PostgREST: cs. expects array literal
  const scopeLiteral = `{${requiredScope}}`;
  const filter = `id=in.(${grantIds.join(',')})&status=eq.active&granted_to_user_id=eq.${user.id}&or=(expires_at.is.null,expires_at.gt.${now})&scopes=cs.${scopeLiteral}`;
  const parents = await sbRest(`/edit_access_grants?select=*&${filter}`, { method: 'GET' });
  return Array.isArray(parents) && parents.length > 0;
}

export async function updateAgent(req: Request, res: Response) {
  try {
    const { id, updates } = req.body || {};
    const actor = await getAuthUser(req.headers.authorization as string | undefined);
    // Load agent to determine org and authorization
    const agentRows = await sbRest(`/agents?id=eq.${id}&select=id,org_id`, { method: 'GET' });
    const agent = agentRows?.[0];
    if (!agent) return res.status(404).send('not_found');
    // Allow: actor is admin OR actor belongs to agent org
    const admin = await isAdminUser(req);
    if (!admin && (!actor || actor.id !== agent.org_id)) return res.status(403).send('forbidden');

    const { name, status, domains, leads_doc_url } = updates || {};
    const patch: any = { name, status, domains, leads_doc_url, updated_at: new Date().toISOString() };
    const rows = await sbRest(`/agents?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const updated = rows?.[0];
    await audit('agent.update', {
      org_id: agent.org_id,
      user_id: actor?.id,
      actor_email: actor?.email,
      target: `agent:${id}`,
      diff: patch
    });
    res.json(updated);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

export async function updateTheme(req: Request, res: Response) {
  try {
    const { agent_id, config } = req.body || {};
    const actor = await getAuthUser(req.headers.authorization as string | undefined);
    // Load agent to determine org and authorization
    const agentRows = await sbRest(`/agents?id=eq.${agent_id}&select=id,org_id`, { method: 'GET' });
    const agent = agentRows?.[0];
    if (!agent) return res.status(404).send('not_found');
    const admin = await isAdminUser(req);
    if (!admin && (!actor || actor.id !== agent.org_id)) return res.status(403).send('forbidden');

    // one-row-per-agent model (unique constraint on agent_id)
    const existingRows = await sbRest(`/agent_themes?agent_id=eq.${agent_id}&select=id,version`, { method: 'GET' });
    const existing = existingRows?.[0] as { id: string; version?: number } | undefined;
    let nextVersion = 1;
    let result: any = null;
    if (existing) {
      nextVersion = existing.version ? Number(existing.version) + 1 : 1;
      const patch = { config, version: nextVersion } as any;
      const updRows = await sbRest(`/agent_themes?agent_id=eq.${agent_id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      result = updRows?.[0] || { agent_id, ...patch };
    } else {
      nextVersion = 1;
      const insertPayload = { agent_id, config, version: nextVersion } as any;
      const insRows = await sbRest(`/agent_themes`, { method: 'POST', body: JSON.stringify([insertPayload]) });
      result = insRows?.[0] || insertPayload;
    }

    await audit('theme.update', {
      org_id: agent.org_id,
      user_id: actor?.id,
      actor_email: actor?.email,
      target: `agent:${agent_id}`,
      version: nextVersion
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

async function isAdminUser(req: Request) {
  const user = await getAuthUser(req.headers.authorization as string | undefined);
  if (!user) return false;
  const rows = await sbRest(`/staff?user_id=eq.${user.id}&select=role`, { method: 'GET' });
  const role = rows?.[0]?.role as string | undefined;
  return !!role && (role === 'owner' || role === 'staff');
}

// export async function listAllAgents(req: Request, res: Response) {
//   try {
//     if (!(await isAdminUser(req))) return res.status(403).send('Admin only');
//     const rows = await sbRest(`/agents?select=*&deleted_at=is.null&order=created_at.desc`, { method: 'GET' });
//     res.json(rows || []);
//   } catch (e: any) {
//     res.status(500).send(e?.message || 'server_error');
//   }
// }

export async function createAgent(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).send('Admin only');
    const { org_id, name, themeConfig } = req.body || {};
    if (!org_id || !name) return res.status(400).send('org_id and name required');

    const rows = await sbRest('/agents', {
      method: 'POST',
      body: JSON.stringify([{ org_id, name, public_id: randomId(10), status: 'draft' }])
    });
    const agent = rows?.[0];
    if (!agent?.id) throw new Error('create agent failed');

    const themeRows = await sbRest('/agent_themes', {
      method: 'POST',
      body: JSON.stringify([{ agent_id: agent.id, config: themeConfig || {}, version: 1 }])
    });
    const theme = themeRows?.[0] || null;

    const actor = await getAuthUser(req.headers.authorization as string | undefined).catch(() => null);
    await audit('agent.create', { org_id, user_id: actor?.id, actor_email: actor?.email, target: `agent:${agent.id}` });
    res.json({ agent, theme });
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

// Admin-only: list all agents across orgs (non-deleted)
export async function listAllAgents(req: Request, res: Response) {
  try {
    if (!(await isAdminUser(req))) return res.status(403).send('Admin only');
    const rows = await sbRest(`/agents?select=*,orgs(name)&deleted_at=is.null&order=created_at.desc`, { method: 'GET' });
    res.json(rows || []);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

// Admin-only: fetch a single agent by id (regardless of org)
export async function getAgentById(req: Request, res: Response) {
  try {
    const { id } = req.params as { id: string };
    const rows = await sbRest(`/agents?id=eq.${id}&select=*`, { method: 'GET' });
    const agent = rows?.[0] || null;
    if (!agent) return res.status(404).send('not_found');
    res.json(agent);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

// Admin-only: fetch latest theme for an agent
export async function getLatestTheme(req: Request, res: Response) {
  try {
    const { agentId } = req.params as { agentId: string };
    const rows = await sbRest(`/agent_themes?agent_id=eq.${agentId}&select=*&order=version.desc&limit=1`, { method: 'GET' });
    const theme = rows?.[0] || null;
    if (!theme) return res.status(404).send('not_found');
    res.json(theme);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

// Public endpoints (by public_id)
export async function getPublicAgentByPublicId(req: Request, res: Response) {
  try {
    const { publicId } = req.params as { publicId: string };
    if (!publicId) return res.status(400).send('public_id_required');
    // Return minimal fields required by widget; exclude deleted
    const rows = await sbRest(`/agents?public_id=eq.${publicId}&deleted_at=is.null&select=id,public_id,name,domains,status`, { method: 'GET' });
    const agent = rows?.[0] || null;
    if (!agent) return res.status(404).send('not_found');
    res.json(agent);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}

export async function getPublicThemeByPublicId(req: Request, res: Response) {
  try {
    const { publicId } = req.params as { publicId: string };
    if (!publicId) return res.status(400).send('public_id_required');
    // Lookup agent id then get latest theme
    const agents = await sbRest(`/agents?public_id=eq.${publicId}&deleted_at=is.null&select=id`, { method: 'GET' });
    const agent = agents?.[0];
    if (!agent?.id) return res.status(404).send('not_found');
    const rows = await sbRest(`/agent_themes?agent_id=eq.${agent.id}&select=*&order=version.desc&limit=1`, { method: 'GET' });
    const theme = rows?.[0] || null;
    if (!theme) return res.status(404).send('not_found');
    res.json(theme);
  } catch (e: any) {
    res.status(500).send(e?.message || 'server_error');
  }
}
