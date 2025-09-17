import type { Request, Response } from 'express';
import { sbRest } from '../../lib/supabase.js';

type AgentRow = {
  id: string;
  org_id: string;
  public_id: string;
  name: string;
  status: 'draft' | 'paused' | 'live';
  domains: string[] | null;
  leads_doc_url?: string | null;
  deleted_at?: string | null;
};

type ThemeRow = {
  agent_id: string;
  version: number;
  config: Record<string, any> | null;
  updated_at?: string | null;
};

async function fetchAgent(publicId: string): Promise<AgentRow | null> {
  const path = `/agents?public_id=eq.${encodeURIComponent(publicId)}&select=id,org_id,public_id,name,status,domains,leads_doc_url,deleted_at`;
  const rows = await sbRest(path, { method: 'GET' });
  const agent = Array.isArray(rows) ? (rows[0] as AgentRow | undefined) : null;
  if (!agent || agent.deleted_at) return null;
  return agent;
}

async function fetchTheme(agentId: string): Promise<ThemeRow | null> {
  const path = `/agent_themes?agent_id=eq.${agentId}&select=agent_id,version,config,updated_at&order=version.desc&limit=1`;
  const rows = await sbRest(path, { method: 'GET' });
  const theme = Array.isArray(rows) ? (rows[0] as ThemeRow | undefined) : null;
  return theme || null;
}

export async function getWidgetConfig(req: Request, res: Response) {
  try {
    const publicId = String(req.query.publicId || req.query.public_id || '').trim();
    if (!publicId) return res.status(400).json({ error: 'public_id_required' });

    const agent = await fetchAgent(publicId);
    if (!agent || agent.status !== 'live') return res.status(404).json({ error: 'agent_not_found' });

    const theme = await fetchTheme(agent.id);

    // Lightweight cache via theme version
    const etagSource = JSON.stringify({ v: theme?.version || 0, updated: theme?.updated_at || null });
    const etag = 'W/"' + Buffer.from(etagSource).toString('base64') + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const payload = {
      agent: {
        id: agent.id,
        publicId: agent.public_id,
        name: agent.name,
        status: agent.status,
      },
      theme: {
        version: theme?.version || 0,
        config: theme?.config || {},
        updatedAt: theme?.updated_at || null,
      },
      assets: (theme?.config && (theme.config as Record<string, any>).assets) || {},
      integrations: {
        leadsDocUrl: agent.leads_doc_url || null,
      },
      allowedDomains: agent.domains || [],
    };

    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'server_error' });
  }
}

