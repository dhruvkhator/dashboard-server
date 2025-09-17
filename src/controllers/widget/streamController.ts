import type { Request, Response } from 'express';
import { sbRest } from '../../lib/supabase.js';

type AgentRow = { id: string; public_id: string; status: 'draft'|'paused'|'live'; deleted_at?: string|null };
type SecretsRow = { n8n_webhook_url?: string|null; n8n_headers?: Record<string,string>|null };

async function fetchAgent(publicId: string): Promise<AgentRow | null> {
  const path = `/agents?public_id=eq.${encodeURIComponent(publicId)}&select=id,public_id,status,deleted_at`;
  const rows = await sbRest(path, { method: 'GET' });
  const agent = Array.isArray(rows) ? (rows[0] as AgentRow | undefined) : null;
  if (!agent || agent.deleted_at) return null;
  return agent;
}

async function fetchSecrets(agentId: string): Promise<SecretsRow | null> {
  const path = `/agent_secrets?agent_id=eq.${agentId}&select=n8n_webhook_url,n8n_headers`;
  const rows = await sbRest(path, { method: 'GET', headers: { 'Accept-Profile': 'private' } });
  const secret = Array.isArray(rows) ? (rows[0] as SecretsRow | undefined) : null;
  return secret || null;
}

export async function chatStream(req: Request, res: Response) {
  const publicId = String(req.query.publicId || req.query.agentPublicId || '').trim();
  if (!publicId) return res.status(400).json({ error: 'public_id_required' });

  try {
    const agent = await fetchAgent(publicId);
    if (!agent || agent.status !== 'live') return res.status(404).json({ error: 'agent_not_found' });

    const secrets = await fetchSecrets(agent.id);
    if (!secrets?.n8n_webhook_url) return res.status(502).json({ error: 'upstream_unavailable' });

    const upstreamUrl = new URL(secrets.n8n_webhook_url);
    upstreamUrl.searchParams.set('publicId', publicId);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'publicId' || key === 'agentPublicId') continue;
      upstreamUrl.searchParams.set(key, String(value));
    }

    // Begin streaming relay (SSE or chunked)
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    (res as any).flushHeaders?.();

    const abortController = new AbortController();
    const connectTimeout = setTimeout(() => abortController.abort(), 1000);

    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        ...(secrets.n8n_headers || {}),
        'user-agent': String(req.headers['user-agent'] || 'cw-widget/relay'),
      },
      signal: abortController.signal,
    }).catch((err: Error) => {
      throw Object.assign(new Error('upstream_fetch_failed'), { status: 502, cause: err });
    });

    clearTimeout(connectTimeout);

    if (!upstream || !upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'upstream_error', status: upstream?.status || 500 });
    }

    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      abortController.abort();
      res.end();
    };
    req.on('close', onClose);

    // Support both WHATWG and Node streams
    const body: any = upstream.body as any;
    if (typeof body.getReader === 'function') {
      (async () => {
        try {
          const reader = body.getReader();
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) res.write(Buffer.from(value));
          }
        } finally {
          onClose();
        }
      })();
    } else if (typeof body.pipe === 'function') {
      body.on('data', (chunk: Buffer) => res.write(chunk));
      body.on('end', onClose);
      body.on('error', onClose);
    } else {
      res.status(502).json({ error: 'upstream_stream_unsupported' });
    }
  } catch (err: any) {
    const status = err?.status || 500;
    if (!res.headersSent) return res.status(status).json({ error: err?.message || 'server_error' });
    return res.end();
  }
}

