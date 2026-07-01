// Outbound customer-messaging gateways (LINE / SMS / email). Provider-agnostic, mirroring the payment
// gateway pattern: a channel resolves to a real provider when its credentials are configured, otherwise a
// Mock that records the message as 'sent' (dev/demo). LINE has a real push implementation (the dominant
// Thai channel); SMS is a provider-agnostic HTTP client (any bulk-SMS REST API) and email is SMTP via
// nodemailer — both activate the moment their env is set, else they fall through to the dev mock. The
// abstraction + delivery log let the rest of the system work today and a real client drops in via env.
import nodemailer, { type Transporter } from 'nodemailer';

const rnd = () => Math.random().toString(36).slice(2, 12);

export type MessageChannel = 'line' | 'sms' | 'email';
export interface SendResult { status: 'sent' | 'failed'; provider: string; ref?: string; error?: string }

// Read credentials at call time (not module-load) so a late-injected secret takes effect without a
// restart — mirrors the payment-gateway resolver. A channel is "configured" iff its primary token is set:
//   LINE  → LINE_CHANNEL_TOKEN   SMS → SMS_API_KEY (+ SMS_API_URL)   email → SMTP_HOST
function channelToken(channel: MessageChannel): string | undefined {
  return channel === 'line' ? process.env.LINE_CHANNEL_TOKEN : channel === 'sms' ? process.env.SMS_API_KEY : process.env.SMTP_HOST;
}

export function resolveMessageGateway(channel: MessageChannel) {
  const token = channelToken(channel);
  const configured = !!token;
  const provider = configured ? channel : 'mock';
  return {
    provider,
    async send(recipient: string, body: string): Promise<SendResult> {
      // Each channel has a real client that activates once its env is set; until then all fall through to
      // the dev mock so the delivery log + campaign flows work end-to-end without a provider account.
      if (configured && channel === 'line') return sendLinePush(token!, recipient, body);
      if (configured && channel === 'sms') return sendSms(token!, recipient, body);
      if (configured && channel === 'email') return sendEmail(recipient, body);
      return { status: 'sent', provider, ref: `${provider}_${rnd()}` };
    },
  };
}

// LINE Messaging API push (https://api.line.me/v2/bot/message/push). The recipient is a LINE userId the
// customer obtained by adding the shop's Official Account / via LINE Login. Network or API errors return
// 'failed' (logged in message_log) rather than throwing, so a receipt send never crashes the POS flow.
async function sendLinePush(token: string, to: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { status: 'failed', provider: 'line', error: `LINE ${res.status} ${detail}`.trim().slice(0, 300) };
    }
    return { status: 'sent', provider: 'line', ref: res.headers.get('x-line-request-id') ?? `line_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'line', error: String(e?.message ?? e).slice(0, 300) };
  }
}

// LINE OA broadcast (https://api.line.me/v2/bot/message/broadcast) — pushes ONE message to EVERY follower of
// the shop's Official Account. Unlike a per-member push/blast, there is no recipient list and no per-member
// consent filter: the audience is LINE's OA follower set (consent = the user followed the OA; they opt out by
// unfollowing). Use for public announcements. Errors return 'failed' (logged), never throw.
export async function broadcastLine(token: string, text: string): Promise<SendResult> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { status: 'failed', provider: 'line', error: `LINE ${res.status} ${detail}`.trim().slice(0, 300) };
    }
    return { status: 'sent', provider: 'line', ref: res.headers.get('x-line-request-id') ?? `line_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'line', error: String(e?.message ?? e).slice(0, 300) };
  }
}

// Is the LINE push/broadcast channel configured (an OA channel token present)? Lets the service decide whether
// a broadcast will really send or fall through to the mock (logged as sent).
export function lineConfigured(): boolean {
  return !!process.env.LINE_CHANNEL_TOKEN;
}

// SMS via a provider-agnostic HTTP REST call — works with most Thai bulk-SMS gateways (ThaiBulkSMS, Twilio,
// AWS SNS proxies, …) that accept a JSON POST with a Bearer key. Endpoint + optional sender come from env so
// no provider is hard-coded. Config: SMS_API_KEY (Bearer), SMS_API_URL (endpoint), SMS_SENDER (optional
// alphanumeric sender id). Non-2xx / network errors return 'failed' (logged), never throw.
async function sendSms(apiKey: string, to: string, text: string): Promise<SendResult> {
  const url = process.env.SMS_API_URL;
  if (!url) return { status: 'failed', provider: 'sms', error: 'SMS_API_URL not set' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to, message: text.slice(0, 1000), ...(process.env.SMS_SENDER ? { sender: process.env.SMS_SENDER } : {}) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { status: 'failed', provider: 'sms', error: `SMS ${res.status} ${detail}`.trim().slice(0, 300) };
    }
    return { status: 'sent', provider: 'sms', ref: `sms_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'sms', error: String(e?.message ?? e).slice(0, 300) };
  }
}

// Email via SMTP (nodemailer). Config: SMTP_HOST (activates the channel), SMTP_PORT (default 587), SMTP_USER,
// SMTP_PASS, SMTP_FROM (envelope from), SMTP_SECURE ('true' ⇒ implicit TLS/465). Convention: if the body has
// a first line followed by a blank line it is used as the Subject and the remainder as the text body; else a
// default subject applies. Transport is cached per host:port so a blast reuses one pool. Errors → 'failed'.
let mailer: { key: string; tx: Transporter } | null = null;
function transport(): Transporter {
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const key = `${host}:${port}:${process.env.SMTP_USER ?? ''}`;
  if (mailer?.key === key) return mailer.tx;
  const tx = nodemailer.createTransport({
    host, port, secure: process.env.SMTP_SECURE === 'true',
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } } : {}),
  });
  mailer = { key, tx };
  return tx;
}

async function sendEmail(to: string, body: string): Promise<SendResult> {
  const nl = body.indexOf('\n\n');
  const subject = nl > 0 ? body.slice(0, nl).trim().slice(0, 200) : (process.env.SMTP_SUBJECT ?? 'แจ้งข่าวสาร');
  const text = nl > 0 ? body.slice(nl + 2) : body;
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'no-reply@localhost';
  try {
    const info = await transport().sendMail({ from, to, subject, text });
    return { status: 'sent', provider: 'email', ref: info.messageId ?? `email_${rnd()}` };
  } catch (e: any) {
    return { status: 'failed', provider: 'email', error: String(e?.message ?? e).slice(0, 300) };
  }
}
