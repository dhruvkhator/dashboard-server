import type { Request, Response } from 'express';
import { sbRest } from '../../lib/supabase.js';

type AgentRow = { id: string; org_id: string; public_id: string; status: 'draft'|'paused'|'live'; deleted_at?: string|null };

type UsageEvent = {
  event_type: 'widget_opened'|'rating_submitted'|'error';
  ts?: string;
  url?: string;
  ua?: string;
  country?: string;
  payload?: Record<string, any>;
};

async function fetchAgent(publicId: string): Promise<AgentRow | null> {
  const rows = await sbRest(`/agents?public_id=eq.${encodeURIComponent(publicId)}&select=id,org_id,public_id,status,deleted_at`, { method: 'GET' });
  const agent = Array.isArray(rows) ? (rows[0] as AgentRow | undefined) : null;
  if (!agent || agent.deleted_at) return null;
  return agent;
}

export async function postWidgetEvents(req: Request, res: Response) {
  try {
    const publicId = String(req.query.agentPublicId || req.query.publicId || '').trim();
    if (!publicId) return res.status(400).json({ error: 'public_id_required' });

    const agent = await fetchAgent(publicId);
    if (!agent || agent.status !== 'live') return res.status(404).json({ error: 'agent_not_found' });

    const events = (Array.isArray(req.body) ? req.body : [req.body]) as UsageEvent[];
    if (!events.length) return res.status(400).json({ error: 'events_required' });
    if (events.length > 50) return res.status(400).json({ error: 'too_many_events' });

    const nowIso = new Date().toISOString();
    const uaHeader = String(req.headers['user-agent'] || '');
    const urlHeader = typeof req.headers['referer'] === 'string' ? req.headers['referer'] : null;

    const rows = events.map((e) => ({
      org_id: agent.org_id,
      agent_id: agent.id,
      agent_session_id: null,
      event_type: e.event_type,
      ts: e.ts || nowIso,
      url: e.url ?? urlHeader,
      ua: e.ua || uaHeader,
      country: e.country || null,
      payload: e.payload || null,
    }));

    await sbRest('/usage_events', { method: 'POST', body: JSON.stringify(rows) });
    return res.json({ accepted: rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'server_error' });
  }
}

