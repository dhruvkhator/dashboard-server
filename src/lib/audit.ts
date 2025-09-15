import { sbRest } from './supabase.js';

// Enable by default; set AUDIT_ENABLED=0 to disable
const AUDIT_ENABLED = process.env.AUDIT_ENABLED !== '0';

export async function audit(action: string, meta: Record<string, any>) {
  if (!AUDIT_ENABLED) {
    // eslint-disable-next-line no-console
    console.log('[audit:disabled]', action, meta);
    return;
  }

  const payload: any = {
    action,
    org_id: meta.org_id || meta.target_org_id || meta.actor_user_id || null,
    user_id: meta.user_id || meta.actor_user_id || null,
    target: meta.target || null,
    details: meta || {}
  };

  if (!payload.org_id) {
    // org_id is required by schema; if missing, log to console to avoid DB error
    // eslint-disable-next-line no-console
    console.log('[audit:skipped-missing-org]', action, meta);
    return;
  }

  try {
    await sbRest('/audit_log', {
      method: 'POST',
      body: JSON.stringify([payload])
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[audit:db-failed]', action, e);
  }
}
