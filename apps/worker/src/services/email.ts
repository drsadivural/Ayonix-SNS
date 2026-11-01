// Transactional email. Production uses a real provider (Resend HTTP API).
// Local development/test stores messages in a clearly labeled dev mailbox
// table instead of pretending to deliver them; deployed environments fail
// closed when email is not configured.
import type { Env } from '../lib/env.js';
import { emailConfigured, isLocal } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { first, run } from '../lib/db.js';
import { log } from '../security/redact.js';

export interface EmailMessage {
  to: string;
  template: string;
  subject: string;
  text: string;
  workspaceId?: string | null;
  identityId?: string | null;
  dedupeKey?: string | null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function html(text: string): string {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;color:#10233F;line-height:1.5">${body}<p style="color:#5B6B82;font-size:12px">Ayonix-SNS</p></body></html>`;
}

export async function sendEmail(env: Env, msg: EmailMessage): Promise<{ id: string; transport: 'resend' | 'dev_mailbox' }> {
  if (msg.dedupeKey) {
    const existing = await first<{ id: string; transport: 'resend' | 'dev_mailbox' }>(env, 'SELECT id, transport FROM sent_notifications WHERE dedupe_key = ? AND status = ?', msg.dedupeKey, 'sent');
    if (existing) return existing;
  }
  const id = newId('ntf');
  if (emailConfigured(env)) {
    let providerId: string | null = null;
    let error: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': msg.dedupeKey ?? id },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: html(msg.text) }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) error = `HTTP ${res.status}: ${body.message ?? 'send failed'}`.slice(0, 200);
      else providerId = body.id ?? null;
    } catch {
      error = 'Email provider unreachable';
    }
    await run(
      env,
      `INSERT INTO sent_notifications(id, workspace_id, identity_id, recipient, template, transport, status, provider_message_id, error, dedupe_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, msg.workspaceId ?? null, msg.identityId ?? null, msg.to, msg.template, 'resend', error ? 'failed' : 'sent', providerId, error, error ? null : msg.dedupeKey ?? null, nowIso(),
    );
    if (error) {
      log('error', 'email.failed', { template: msg.template, error });
      throw new AppError('upstream_error', 'The email could not be sent. Try again shortly.', { retryable: true });
    }
    return { id, transport: 'resend' };
  }
  if (!isLocal(env)) throw new AppError('not_configured', 'Email delivery is not configured on this deployment');
  await run(
    env,
    `INSERT INTO sent_notifications(id, workspace_id, identity_id, recipient, template, transport, status, dedupe_key, dev_body, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, msg.workspaceId ?? null, msg.identityId ?? null, msg.to, msg.template, 'dev_mailbox', 'sent', msg.dedupeKey ?? null, `${msg.subject}\n\n${msg.text}`, nowIso(),
  );
  return { id, transport: 'dev_mailbox' };
}
