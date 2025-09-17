import type { Request, Response } from 'express';
import { sbRest } from '../../lib/supabase.js';
import { getDeviceRand, getRequestIp, isPageLoad } from '../../lib/widgetUtils.js';

type AgentRow = {
  id: string;
  org_id: string;
  public_id: string;
  status: 'draft' | 'paused' | 'live';
  deleted_at?: string | null;
};

type SessionRow = { id: string; last_seen_at: string | null; message_count?: number | null };

type IngestItem = {
  idx?: number;
  id?: string;
  session_id?: string;
  message: string | { type?: 'human' | 'ai' | 'system'; content?: string; [k: string]: unknown };
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
};

function parseMessage(item: IngestItem) {
  let payload: { type?: string; content?: string; [k: string]: unknown } = {};
  if (typeof item.message === 'string') {
    try { payload = JSON.parse(item.message); } catch { payload = { content: item.message }; }
  } else if (item.message && typeof item.message === 'object') {
    payload = item.message as any;
  }
  const type = String(payload.type || '').toLowerCase();
  const direction: 'user'|'ai'|'system' = type === 'human' ? 'user' : type === 'system' ? 'system' : 'ai';
  const text = typeof payload.content === 'string' ? payload.content : '';
  return { direction, text, raw: payload } as const;
}

async function fetchAgent(publicId: string): Promise<AgentRow | null> {
  const rows = await sbRest(`/agents?public_id=eq.${encodeURIComponent(publicId)}&select=id,org_id,public_id,status,deleted_at`, { method: 'GET' });
  const agent = Array.isArray(rows) ? (rows[0] as AgentRow | undefined) : null;
  if (!agent || agent.deleted_at) return null;
  return agent;
}

async function resolveSession(agent: AgentRow, ip: string, rand: string, forceNew: boolean): Promise<{ id: string; previousCount: number } | null> {
  const nowIso = new Date().toISOString();
  if (!forceNew) {
    const rows = await sbRest(`/agent_sessions?agent_id=eq.${agent.id}&ip=eq.${encodeURIComponent(ip)}&select=id,last_seen_at,message_count&order=started_at.desc&limit=1`, { method: 'GET' });
    const existing = Array.isArray(rows) ? (rows[0] as SessionRow | undefined) : undefined;
    if (existing?.id) {
      const lastSeen = existing.last_seen_at ? new Date(existing.last_seen_at).getTime() : 0;
      if (Date.now() - lastSeen <= 6 * 60 * 60 * 1000) {
        return { id: existing.id, previousCount: typeof existing.message_count === 'number' ? existing.message_count! : 0 };
      }
    }
  }

  const inserted = await sbRest('/agent_sessions', {
    method: 'POST',
    body: JSON.stringify([
      {
        org_id: agent.org_id,
        agent_id: agent.id,
        ip,
        user_cookie: rand,
        device_fingerprint: null,
        started_at: nowIso,
        last_seen_at: nowIso,
        message_count: 0,
      },
    ]),
  });
  const session = Array.isArray(inserted) ? (inserted[0] as { id: string } | undefined) : undefined;
  if (!session?.id) return null;
  return { id: session.id, previousCount: 0 };
}

async function bumpSession(sessionId: string, userMessages: number, previousCount: number) {
  const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (userMessages > 0) patch.message_count = previousCount + userMessages;
  await sbRest(`/agent_sessions?id=eq.${sessionId}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => null);
}

export async function postIngestMessages(req: Request, res: Response) {
  try {
    const publicId = String(req.query.agentPublicId || req.query.publicId || '').trim();
    if (!publicId) return res.status(400).json({ error: 'public_id_required' });

    const agent = await fetchAgent(publicId);
    if (!agent || agent.status !== 'live') return res.status(404).json({ error: 'agent_not_found' });

    const body = (Array.isArray(req.body) ? req.body : [req.body]) as IngestItem[];
    if (!body.length) return res.status(400).json({ error: 'messages_required' });
    if (body.length > 100) return res.status(400).json({ error: 'too_many_messages' });

    const ip = getRequestIp(req);
    const rand = getDeviceRand(req);
    if (!rand) return res.status(400).json({ error: 'device_rand_required' });
    const reuse = !isPageLoad(req);

    const session = await resolveSession(agent, ip, rand, !reuse);
    if (!session) return res.status(500).json({ error: 'session_resolution_failed' });

    let userCount = 0;
    const now = new Date();
    const url = (typeof req.query.url === 'string' ? req.query.url : null) || (typeof req.headers['referer'] === 'string' ? req.headers['referer'] : null);
    const ua = String(req.headers['user-agent'] || '');
    const country = typeof req.query.country === 'string' ? req.query.country : null;

    const rows = body.map((item) => {
      const parsed = parseMessage(item);
      if (parsed.direction === 'user') userCount += 1;
      return {
        org_id: agent.org_id,
        agent_id: agent.id,
        agent_session_id: session.id,
        direction: parsed.direction,
        text: parsed.text || null,
        raw: parsed.raw || null,
        ts: new Date(now.getTime()).toISOString(),
        url,
        ua,
        country,
        tokens_in: item.tokens_in ?? null,
        tokens_out: item.tokens_out ?? null,
        latency_ms: item.latency_ms ?? null,
      };
    });

    await sbRest('/chat_messages', { method: 'POST', body: JSON.stringify(rows) });
    await bumpSession(session.id, userCount, session.previousCount);

    return res.json({ accepted: rows.length, sessionId: session.id });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'server_error' });
  }
}

